// Everything a batch does to the machine: worktrees, sessions, the agent
// processes in them, and the messages typed into those processes.
//
// It is the only part of the extension that touches `host`, and the only part
// that runs with no browser open. A cluster is started from a route, but
// everything after that - a worker reporting a ticket, a hook saying it is
// waiting on you, a window dying - arrives here and lands in the store, which
// is what lets a batch carry on while the tab is closed.
//
// Shape borrowed from the agent-tasks extension's server.js (the resident
// `instance`, the liveness sweep, the launch line, the CLI install): the same
// problems, solved the same way, in a copy because two installed extensions
// share no modules.
import { appendFile, chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills, parseSkillPaths, resolveSlot } from "./skills.mjs";
import {
  activeKey,
  addNote,
  clusterOf,
  clusterSeen,
  clusterState,
  hookEvent,
  markClosed,
  markFeedbackSent,
  markResumed,
  markRunning,
  markStartFailed,
  markStarting,
  markStopped,
  markQaArtifacts,
  markWorktreeRemoved,
  recordQa,
  specReady,
  remainingTickets,
  sendableFeedback,
  ticketReport,
} from "./batchModel.mjs";
import {
  buildAdditionalTicketsMessage,
  buildClusterBrief,
  buildClusterBriefLine,
  buildFeedbackMessage,
  buildResumeMessage,
} from "./brief.mjs";
import { createControlServer } from "./batchControl.mjs";
import { writeAndRender } from "./qaSpec.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const SWEEP_MS = 15_000;
// A session created a moment ago may not have its window ready for text yet;
// the send 404s until it does. Same budget the client's own hand-over uses.
const SEND_RETRIES = 12;
const SEND_DELAY_MS = 400;
// The events a cluster's state depends on. Subscribing to more would make the
// user's installed hooks stale for nothing (core installs the union of what
// its subscribers ask for).
const HOOK_EVENTS = ["permission", "stop", "prompt-submit", "session-start"];

const DIRTY_WORKTREE = /contains modified or untracked files/i;

// One activation per process is not guaranteed: disabling and re-enabling the
// extension calls activate() again on the already-resident module, and a
// second socket bind or a second sweep timer would be a real bug rather than
// a tidy-up problem.
let instance = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Byte-identical to src/naming.ts's - session names cannot contain "." or ":".
function sessionNameFor(branch) {
  return branch.replace(/[.:/\s]+/g, "-").replace(/^-+|-+$/g, "");
}

// Bracketed paste, so a multi-line brief arrives in the agent's composer as
// ONE message instead of each newline submitting what came before it.
function asPaste(text) {
  return text.includes("\n") ? `\u001b[200~${text}\u001b[201~` : text;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

class RunnerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createBatchRunner({
  host,
  getSettings,
  store,
  readConfig,
  issueDetail,
  createWorktree,
  progressIssue,
  configDir,
  log = console.log,
}) {
  const binDir = path.join(configDir, "bin");
  const cliPath = path.join(binDir, "jira-batch");
  const socketPath = path.join(configDir, "jira", "batch.sock");

  // ---- Host capabilities ----
  //
  // This ships from the registry and can be installed on any core, including
  // one older than host.sessions. Reaching for a missing one inside an async
  // route used to take the whole server down with it, so every entry point
  // asks first and answers 501 with something the user can act on.
  function requireHost() {
    if (!host?.sessions?.create || !host?.sessions?.sendTextToWindow) {
      throw new RunnerError(501, "this perch is too old to run batches - update it (needs host.sessions)");
    }
    if (!host?.worktrees?.create) {
      throw new RunnerError(501, "this perch is too old to create worktrees - update it");
    }
    if (!host?.agents?.launchCommand) {
      throw new RunnerError(501, "this perch is too old to launch agents - update it");
    }
  }

  async function sendToWindow(windowId, text, { retries = SEND_RETRIES } = {}) {
    let attempt = 0;
    for (;;) {
      try {
        await host.sessions.sendTextToWindow(windowId, text, true);
        return;
      } catch (err) {
        // A window that is not there yet 404s; a window that will never be
        // there 404s too, which is why this gives up rather than waiting.
        if (attempt >= retries) throw err;
        attempt += 1;
        await sleep(SEND_DELAY_MS);
      }
    }
  }

  async function details(cfg, keys) {
    const out = [];
    for (const key of keys) {
      try {
        out.push(await issueDetail(cfg, key));
      } catch (err) {
        // A ticket Jira will not serve right now must not stop the cluster
        // that holds four others from starting.
        log(`could not fetch ${key} for a cluster brief: ${err.message}`);
        out.push({
          key,
          summary: key,
          description: "(this ticket could not be fetched from Jira when the cluster started)",
          status: "",
          type: "",
          priority: null,
          labels: [],
          components: [],
          parent: null,
          comments: [],
          url: "",
        });
      }
    }
    return out;
  }

  // ---- The skills a cluster runs with ----

  const BUNDLED_QA_SKILL = "jira-batch-qa";
  const DEFAULT_EXECUTION_SKILL = "execute-jira-ticket";
  // Where the bundled skill is written inside a cluster's worktree. Relative,
  // because it is also the exact line added to info/exclude.
  const BUNDLED_REL = path.join(".claude", "skills", BUNDLED_QA_SKILL);

  function git(args, cwd) {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd, encoding: "utf8", timeout: 15_000 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    });
  }

  // Exactly this path, and nothing above it. The extension's own
  // ensureExcluded() excludes the FIRST path component, which here would be
  // `.claude` - hiding the user's whole Claude directory, including skills
  // and settings they put there themselves. That is why this is separate.
  async function excludePath(repo, relative) {
    const pattern = `/${relative.split(path.sep).join("/")}/`;
    let excludeFile;
    try {
      const commonDir = (await git(["rev-parse", "--git-common-dir"], repo)).trim();
      excludeFile = path.resolve(repo, commonDir, "info", "exclude");
    } catch {
      return;
    }
    let current = "";
    try {
      current = await readFile(excludeFile, "utf8");
    } catch {
      // No info/exclude yet; created below.
    }
    if (current.split("\n").some((line) => line.trim() === pattern)) return;
    try {
      await mkdir(path.dirname(excludeFile), { recursive: true });
      const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
      await appendFile(excludeFile, `${prefix}${pattern}\n`);
    } catch {
      // Best effort: a read-only .git must not stop a cluster starting.
    }
  }

  // Written only when the bundled skill is the one in use. Rewritten on every
  // start and resume, so an updated extension updates it.
  async function installBundledSkill(worktreePath, repo) {
    const source = path.join(here, "skills", BUNDLED_QA_SKILL, "SKILL.md");
    const target = path.join(worktreePath, BUNDLED_REL, "SKILL.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(source, "utf8"));
    await excludePath(repo, BUNDLED_REL);
    return path.join(worktreePath, BUNDLED_REL);
  }

  // Copying the bundled skill into the user's own directory, so they can own
  // and edit the procedure.
  //
  // This is the whole adoption story: once it is theirs it is one more entry
  // in the picker, edited like any other skill, and the extension stops
  // writing anything into a worktree for that cluster. Patching the copy
  // inside the extension would be undone by the next update; this would not.
  async function installQaSkillForUser({ force = false } = {}) {
    const source = path.join(here, "skills", BUNDLED_QA_SKILL, "SKILL.md");
    const dir = path.join(os.homedir(), ".claude", "skills", BUNDLED_QA_SKILL);
    const target = path.join(dir, "SKILL.md");
    let existed = false;
    try {
      await stat(target);
      existed = true;
    } catch {
      // Not there, which is the ordinary case.
    }
    // Never silently over a skill they may have spent time on: the caller
    // asks, and only then does this overwrite.
    if (existed && !force) return { ok: false, existed: true, dir, target };
    await mkdir(dir, { recursive: true });
    await writeFile(target, await readFile(source, "utf8"));
    return { ok: true, existed, dir, target };
  }

  // Both slots, resolved against what is installed plus this cluster's own
  // overrides. The extension locates a skill and names it; it never reads one.
  async function resolveSkills({ repo, overrides = {} }) {
    const settings = await getSettings();
    const discovered = await discoverSkills({
      repo,
      extraPaths: parseSkillPaths(settings["jira.skillPaths"]),
    });
    const pick = (override, setting, fallbackName) =>
      resolveSlot(override ?? setting ?? "", discovered, fallbackName);

    const execution = pick(overrides.execution, settings["jira.executionSkill"], DEFAULT_EXECUTION_SKILL);
    const qa = pick(overrides.qa, settings["jira.qaSkill"], BUNDLED_QA_SKILL);
    return {
      discovered,
      execution,
      qa,
      // No execution skill and no explicit "none" means the brief carries a
      // short procedure itself rather than delegating to nothing.
      execFallback: !execution.skill && !execution.explicitNone,
    };
  }

  // An empty QA slot nobody chose falls to the extension's own skill.
  function usesBundledQa(resolved) {
    return !resolved.qa.skill && !resolved.qa.explicitNone && !resolved.qa.missing;
  }

  function skillRecord(resolved) {
    if (!resolved.skill) {
      return resolved.missing
        ? { name: "", dir: "", origin: "", missing: true, wanted: resolved.wanted ?? "" }
        : null;
    }
    return { name: resolved.skill.name, dir: resolved.skill.dir, origin: resolved.skill.origin, missing: false };
  }

  function briefFor(batch, cluster, ticketDetails) {
    return buildClusterBrief({
      batchName: batch.name,
      clusterName: cluster.name,
      criteria: batch.criteria,
      rationale: cluster.rationale,
      files: cluster.files,
      details: ticketDetails,
      skills: cluster.skills,
    });
  }

  // ---- Starting a cluster ----

  async function startOne(batchId, clusterId, agentId, branch, overrides = {}) {
    requireHost();
    const launch = await host.agents.launchCommand(agentId);
    if (!launch) throw new RunnerError(400, `"${agentId}" is not an agent this perch can launch`);

    const before = await store.get();
    const resolved = await resolveSkills({ repo: before.batches[batchId]?.repo ?? null, overrides });
    const skills = {
      execution: skillRecord(resolved.execution),
      qa: usesBundledQa(resolved)
        ? { name: BUNDLED_QA_SKILL, dir: "", origin: "the extension's default", missing: false }
        : skillRecord(resolved.qa),
      execFallback: resolved.execFallback,
    };

    const prepared = await store.update((doc) => {
      const batch = doc.batches[batchId];
      if (!batch) return { ok: false, error: `no batch ${batchId}` };
      return markStarting(batch, clusterId, { branch, agentId, skills, now: Date.now() });
    });
    if (!prepared.ok) throw new RunnerError(409, prepared.error);

    const doc = await store.get();
    const batch = doc.batches[batchId];
    const cluster = clusterOf(batch, clusterId);
    const settings = await getSettings();

    let worktree;
    try {
      // No network on the way in: see createWorktree's own note on why a
      // batch does not fetch where the single button does.
      worktree = await createWorktree(batch.repo, cluster.branch, settings, { offline: true });
    } catch (err) {
      // A name that is taken is the common one, and it is the user's to fix:
      // the cluster stays startable and the row says why.
      await store.update((d) => markStartFailed(d.batches[batchId], clusterId, err.message, Date.now()));
      throw new RunnerError(typeof err?.status === "number" ? err.status : 500, err.message);
    }

    // The bundled skill lives inside the extension, so discovery never finds
    // it: an empty QA slot that nobody set to "none" IS the bundled one, and
    // that is the only case where a file is written into the worktree.
    if (usesBundledQa(resolved)) {
      try {
        await installBundledSkill(worktree.path, batch.repo);
      } catch (err) {
        log(`could not write the bundled QA skill: ${err.message}`);
      }
    }

    let session;
    let pane;
    try {
      session = await host.sessions.create(sessionNameFor(cluster.branch), worktree.path, true);
      const panes = await host.sessions.listPanes(session.name);
      pane = panes[0];
      if (!pane) throw new Error(`session ${session.name} has no window`);
    } catch (err) {
      await store.update((d) => markStartFailed(d.batches[batchId], clusterId, err.message, Date.now()));
      throw new RunnerError(500, err.message);
    }

    await store.update((d) =>
      markRunning(d.batches[batchId], clusterId, {
        worktreePath: worktree.path,
        sessionName: session.name,
        windowId: pane.id,
        agentId,
        now: Date.now(),
      }),
    );

    // The ids and the CLI go on the launch line itself rather than into a
    // file: the agent inherits them, and nothing else in the pane can. The
    // brief goes on it too, as the agent's first prompt - see
    // buildClusterBriefLine for why it cannot follow as a second message.
    try {
      const cfg = await readConfig();
      const ticketDetails = await details(cfg, cluster.keys);
      const briefLine = buildClusterBriefLine({
        batchName: batch.name,
        clusterName: cluster.name,
        criteria: batch.criteria,
        details: ticketDetails,
        skills: skills,
      });
      const line =
        `export JB_SOCK=${shellQuote(socketPath)} JB_BATCH_ID=${shellQuote(batchId)} JB_CLUSTER_ID=${shellQuote(clusterId)}; ` +
        `export PATH=${shellQuote(binDir)}:"$PATH"; ${launch} ${shellQuote(briefLine)}`;
      await sendToWindow(pane.id, line);
    } catch (err) {
      await store.update((d) => markStopped(d.batches[batchId], clusterId, `could not reach its terminal: ${err.message}`, Date.now()));
      throw new RunnerError(500, err.message);
    }

    // Jira-side bookkeeping is the user's existing choice, and a Jira that
    // refuses a transition must never read as "the cluster failed to start" -
    // the agent is already working by now.
    if (settings["jira.updateIssueOnStartWork"] === true) {
      const cfg = await readConfig();
      for (const key of cluster.keys) {
        try {
          const result = await progressIssue(cfg, key);
          if (result.note) await store.update((d) => addNote(d.batches[batchId], clusterId, `${key}: ${result.note}`, Date.now()));
        } catch (err) {
          await store.update((d) => addNote(d.batches[batchId], clusterId, `${key}: ${err.message}`, Date.now()));
        }
      }
    }

    return { clusterId, worktreePath: worktree.path, sessionName: session.name, note: worktree.note };
  }

  // Clusters start one after another, not in parallel: each one runs `git
  // fetch` and `git worktree add` in the same repository, and two of those at
  // once is how you get an index.lock error instead of two worktrees.
  async function startClusters(batchId, clusterIds, agentId, branches = {}, skillOverrides = {}) {
    const started = [];
    const failed = [];
    for (const clusterId of clusterIds) {
      try {
        started.push(await startOne(batchId, clusterId, agentId, branches[clusterId] ?? "", skillOverrides));
      } catch (err) {
        failed.push({ clusterId, error: err.message, status: err.status ?? 500 });
      }
    }
    return { started, failed };
  }

  // ---- Talking to a cluster that is already running ----

  async function handOffAdditional(batchId, clusterId, keys) {
    requireHost();
    const doc = await store.get();
    const batch = doc.batches[batchId];
    const cluster = batch ? clusterOf(batch, clusterId) : null;
    if (!cluster) throw new RunnerError(404, `no cluster ${clusterId}`);
    if (!cluster.windowId) throw new RunnerError(409, `"${cluster.name}" has no terminal to hand tickets to`);
    const cfg = await readConfig();
    const ticketDetails = await details(cfg, keys);
    await sendToWindow(cluster.windowId, asPaste(buildAdditionalTicketsMessage({ clusterName: cluster.name, details: ticketDetails })));

    const settings = await getSettings();
    if (settings["jira.updateIssueOnStartWork"] === true) {
      for (const key of keys) {
        try {
          await progressIssue(cfg, key);
        } catch {
          // Reported in the panel's note only when it matters; the tickets
          // are with the agent either way.
        }
      }
    }
    return { clusterId, keys };
  }

  // Every draft in the batch, one message per cluster. A cluster with no
  // agent to read it keeps its drafts rather than losing them to a send that
  // went nowhere.
  async function sendFeedback(batchId) {
    requireHost();
    const doc = await store.get();
    const batch = doc.batches[batchId];
    if (!batch) throw new RunnerError(404, `no batch ${batchId}`);

    const sent = [];
    const skipped = [];
    for (const group of sendableFeedback(batch)) {
      const cluster = clusterOf(batch, group.clusterId);
      const state = clusterState(batch, cluster);
      if (!cluster.windowId || state === "stopped" || state === "closed" || state === "pending") {
        skipped.push({ clusterId: cluster.id, clusterName: cluster.name, reason: `it is ${state}`, keys: group.items.map((i) => i.key) });
        continue;
      }
      try {
        await sendToWindow(cluster.windowId, asPaste(buildFeedbackMessage({ clusterName: cluster.name, items: group.items })));
      } catch (err) {
        skipped.push({ clusterId: cluster.id, clusterName: cluster.name, reason: err.message, keys: group.items.map((i) => i.key) });
        continue;
      }
      await store.update((d) => markFeedbackSent(d.batches[batchId], cluster.id, group.items.map((i) => i.key), Date.now()));
      sent.push({ clusterId: cluster.id, clusterName: cluster.name, keys: group.items.map((i) => i.key) });
    }
    return { sent, skipped };
  }

  // ---- Stopping, resuming, cleaning up ----

  async function resume(batchId, clusterId) {
    requireHost();
    const doc = await store.get();
    const batch = doc.batches[batchId];
    const cluster = batch ? clusterOf(batch, clusterId) : null;
    if (!cluster) throw new RunnerError(404, `no cluster ${clusterId}`);
    if (clusterState(batch, cluster) !== "stopped") throw new RunnerError(409, `"${cluster.name}" is not stopped`);

    // An agent's resume line picks the conversation back up where it can; one
    // without it starts fresh, which the remaining-tickets message below is
    // written to cope with either way.
    const agents = host.agents.list ? await host.agents.list() : [];
    const agent = agents.find((entry) => entry.id === cluster.agentId);
    const launch = (agent?.resume || (await host.agents.launchCommand(cluster.agentId))) ?? "";
    if (!launch) throw new RunnerError(400, `"${cluster.agentId}" is not an agent this perch can launch`);

    let sessionName = cluster.sessionName;
    let windowId = "";
    const sessions = await host.sessions.list();
    const existing = sessions.find((session) => session.name === sessionName);
    if (existing && host.sessions.createWindow) {
      const index = await host.sessions.createWindow(sessionName, cluster.worktreePath);
      const panes = await host.sessions.listPanes(sessionName);
      windowId = panes.find((pane) => pane.windowIndex === index)?.id ?? "";
    }
    if (!windowId) {
      const session = await host.sessions.create(sessionNameFor(cluster.branch), cluster.worktreePath, true);
      sessionName = session.name;
      windowId = (await host.sessions.listPanes(sessionName))[0]?.id ?? "";
    }
    if (!windowId) throw new RunnerError(500, "could not open a window for the resumed agent");

    await store.update((d) => markResumed(d.batches[batchId], clusterId, { sessionName, windowId, now: Date.now() }));

    // Same rule as the first launch: whatever the resumed agent must read
    // rides on the line, because nothing typed after it arrives before the
    // process is up.
    const fresh = await store.get();
    const freshBatch = fresh.batches[batchId];
    const freshCluster = clusterOf(freshBatch, clusterId);
    const resumeLine = buildResumeMessage({
      clusterName: freshCluster.name,
      remaining: remainingTickets(freshBatch, freshCluster),
    }).replace(/\s+/g, " ").trim();
    const line =
      `export JB_SOCK=${shellQuote(socketPath)} JB_BATCH_ID=${shellQuote(batchId)} JB_CLUSTER_ID=${shellQuote(clusterId)}; ` +
      `export PATH=${shellQuote(binDir)}:"$PATH"; ${launch} ${shellQuote(resumeLine)}`;
    await sendToWindow(windowId, line);
    return { clusterId, sessionName, windowId };
  }

  async function killSession(name) {
    if (!name || !host.sessions?.kill) return;
    try {
      await host.sessions.kill(name);
    } catch (err) {
      // Already gone is the expected case when the user closed it by hand.
      log(`could not kill session ${name}: ${err.message}`);
    }
  }

  async function stopCluster(batchId, clusterId) {
    const doc = await store.get();
    const cluster = doc.batches[batchId] ? clusterOf(doc.batches[batchId], clusterId) : null;
    if (!cluster) throw new RunnerError(404, `no cluster ${clusterId}`);
    await killSession(cluster.sessionName);
    const result = await store.update((d) => markStopped(d.batches[batchId], clusterId, "stopped by you", Date.now()));
    if (!result.ok) throw new RunnerError(409, result.error);
    return { clusterId };
  }

  async function closeCluster(batchId, clusterId) {
    const doc = await store.get();
    const cluster = doc.batches[batchId] ? clusterOf(doc.batches[batchId], clusterId) : null;
    if (!cluster) throw new RunnerError(404, `no cluster ${clusterId}`);
    await killSession(cluster.sessionName);
    await store.update((d) => markClosed(d.batches[batchId], clusterId, Date.now()));
    return { clusterId };
  }

  // The branch always stays. Only a worktree this extension created is ever
  // removed, and never while anything is running in it.
  async function removeWorktree(batchId, clusterId, force) {
    if (!host?.worktrees?.remove) throw new RunnerError(501, "this perch is too old to remove worktrees - update it");
    const doc = await store.get();
    const batch = doc.batches[batchId];
    const cluster = batch ? clusterOf(batch, clusterId) : null;
    if (!cluster) throw new RunnerError(404, `no cluster ${clusterId}`);
    if (clusterState(batch, cluster) !== "closed") throw new RunnerError(409, `close "${cluster.name}" first`);
    if (!cluster.worktreePath) throw new RunnerError(409, `"${cluster.name}" has no worktree`);
    if (cluster.worktreeRemovedAt) return { clusterId, removed: true, dirty: false };

    try {
      await host.worktrees.remove({ cwd: batch.repo, path: cluster.worktreePath, force: force === true });
    } catch (err) {
      // Uncommitted work is a question, not a failure: the panel asks again
      // and comes back with force.
      if (DIRTY_WORKTREE.test(err?.message ?? "")) return { clusterId, removed: false, dirty: true, error: err.message };
      // Already gone from git's view (removed by hand): nothing left to do.
      if (err?.status !== 404) throw new RunnerError(500, err?.message ?? String(err));
    }
    await store.update((d) => markWorktreeRemoved(d.batches[batchId], clusterId, Date.now()));
    return { clusterId, removed: true, dirty: false };
  }

  // ---- Liveness ----
  //
  // Nothing tells the extension that a window died: the agent simply stops
  // reporting. The sweep is what turns that silence into a state the panel
  // can show and a Resume button you can press. Only a MISSING window counts
  // - an agent that is merely quiet may be thinking, and a timeout would
  // punish it for that.
  async function sweep() {
    const doc = await store.get();
    const live = new Set();
    try {
      for (const session of await host.sessions.list()) {
        for (const window of session.windows ?? []) live.add(window.id);
      }
    } catch (err) {
      // A backend that cannot answer must not be read as "every window died".
      log(`liveness sweep could not list sessions: ${err.message}`);
      return;
    }

    for (const batch of Object.values(doc.batches)) {
      if (batch.archivedAt) continue;
      for (const cluster of batch.clusters) {
        if (cluster.state !== "running" || !cluster.windowId) continue;
        if (live.has(cluster.windowId)) continue;
        await store.update((d) => markStopped(d.batches[batch.id], cluster.id, "its terminal window is gone", Date.now()));
        log(`cluster "${cluster.name}" lost its window`);
      }
    }
  }

  // ---- The CLI a worker reports through ----

  async function installCli() {
    await mkdir(binDir, { recursive: true });
    const source = path.join(here, "cli", "jira-batch");
    const tmp = `${cliPath}.${process.pid}.tmp`;
    await copyFile(source, tmp);
    await chmod(tmp, 0o755);
    await rename(tmp, cliPath);
  }

  // ---- Evidence ----
  //
  // Images are COPIED into the extension's own store rather than referenced
  // where the agent left them: a worktree removed after review must not empty
  // the panel, and `.backups/` is the user's to tidy.

  const evidenceDir = path.join(configDir, "jira", "evidence");
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

  // By content, not by extension: a file named .png that is not one would
  // reach an <img> and render as nothing, which reads as a broken feature
  // rather than a rejected file.
  const IMAGE_KINDS = [
    { ext: "png", test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { ext: "jpg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    {
      ext: "webp",
      test: (b) => b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
    },
  ];

  async function exists(file) {
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  }

  async function readImage(label, file) {
    let info;
    try {
      info = await stat(file);
    } catch {
      throw new RunnerError(400, `--${label}: there is no file at ${file}`);
    }
    if (!info.isFile()) throw new RunnerError(400, `--${label}: ${file} is not a file`);
    if (info.size > MAX_IMAGE_BYTES) {
      throw new RunnerError(
        400,
        `--${label}: ${file} is ${Math.round(info.size / 1024 / 1024)}MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`,
      );
    }
    const bytes = await readFile(file);
    const kind = IMAGE_KINDS.find((entry) => entry.test(bytes));
    if (!kind) throw new RunnerError(400, `--${label}: ${file} is not a PNG, JPEG or WebP`);
    return { bytes, ext: kind.ext };
  }

  async function storeImage(batchId, key, label, file) {
    const { bytes, ext } = await readImage(label, file);
    const dir = path.join(evidenceDir, batchId, key);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `${label}.${ext}`);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
    // A ticket re-reported after rework may switch format; the old file would
    // otherwise sit beside the new one and be served by a stale extension.
    for (const other of IMAGE_KINDS) {
      if (other.ext === ext) continue;
      await rm(path.join(dir, `${label}.${other.ext}`), { force: true });
    }
    return { ext };
  }

  // ---- The cluster's report ----
  //
  // Built by the extension from the per-ticket reports rather than by the
  // agent: one less thing to skip at the end of a long run, and rebuilding is
  // just calling this again.

  async function buildClusterReport(batchId, clusterId) {
    const doc = await store.get();
    const batch = doc.batches[batchId];
    const cluster = batch ? clusterOf(batch, clusterId) : null;
    if (!cluster) throw new RunnerError(404, `no cluster ${clusterId}`);

    // The user's own script when their skill is installed, so their
    // improvements reach batch runs; the vendored copy only otherwise.
    const discovered = await discoverSkills({
      repo: batch.repo,
      extraPaths: parseSkillPaths((await getSettings())["jira.skillPaths"]),
    });
    // Their skill having the script is not the same as their skill existing:
    // an older copy of execute-jira-ticket has no scripts/ at all, and
    // assuming otherwise turns a working report into a module-not-found.
    const theirs = discovered.find((skill) => skill.name === DEFAULT_EXECUTION_SKILL);
    const candidate = theirs ? path.join(theirs.dir, "scripts", "qa-report") : "";
    const script = candidate && (await exists(candidate)) ? candidate : path.join(here, "vendor", "qa-report");

    const { specPath, reportPath } = await writeAndRender(batch, cluster, {
      evidenceDir,
      qaReportScript: script,
      repo: cluster.worktreePath || batch.repo,
    });
    await store.update((draft) => markQaArtifacts(draft.batches[batchId], clusterId, { specPath, reportPath }, Date.now()));
    return { specPath, reportPath };
  }

  // Called after any report that might have been the last one. A failure here
  // must never fail the agent's own call - its work is done either way.
  async function maybeBuildReport(batchId, clusterId) {
    try {
      const doc = await store.get();
      const batch = doc.batches[batchId];
      const cluster = batch ? clusterOf(batch, clusterId) : null;
      if (!cluster || !specReady(batch, cluster)) return;
      await buildClusterReport(batchId, clusterId);
    } catch (err) {
      log(`could not build the QA report for ${clusterId}: ${err.message}`);
    }
  }

  // ---- Socket verbs ----
  //
  // One per `jira-batch` verb. Each one is a report from a pane, so the
  // errors are written for whoever is reading that terminal.
  function verbs() {
    const withCluster = async (body, fn) => {
      const batchId = String(body.batchId ?? "");
      const clusterId = String(body.clusterId ?? "");
      if (!batchId || !clusterId) throw new RunnerError(400, "this shell is not inside a batch cluster");
      return fn(batchId, clusterId);
    };

    const report = (verb) => (body) =>
      withCluster(body, async (batchId, clusterId) => {
        const key = String(body.key ?? "").toUpperCase();
        const result = await store.update((doc) => {
          const batch = doc.batches[batchId];
          if (!batch) return { ok: false, error: `no batch ${batchId}` };
          return ticketReport(batch, clusterId, key, verb, {
            summary: body.summary ?? "",
            reason: body.reason ?? "",
            now: Date.now(),
          });
        });
        if (!result.ok) throw new RunnerError(409, result.error);
        // done and fail are the reports that can settle the last ticket.
        await maybeBuildReport(batchId, clusterId);
        return { key, state: result.state };
      });

    return {
      start: report("start"),
      done: report("done"),
      fail: report("fail"),

      qa: (body) =>
        withCluster(body, async (batchId, clusterId) => {
          const key = String(body.key ?? "").toUpperCase();
          // Validate and copy BEFORE touching the store: a refused image must
          // leave no half-written report behind, which is the same rule
          // qa-report applies when it refuses to render a missing screenshot.
          const before = body.before ? await storeImage(batchId, key, "before", String(body.before)) : null;
          const after = body.after ? await storeImage(batchId, key, "after", String(body.after)) : null;
          const result = await store.update((doc) => {
            const batch = doc.batches[batchId];
            if (!batch) return { ok: false, error: `no batch ${batchId}` };
            return recordQa(batch, clusterId, key, { ...body, before, after }, Date.now());
          });
          if (!result.ok) throw new RunnerError(409, result.error);
          await maybeBuildReport(batchId, clusterId);
          return { key, status: result.status };
        }),

      note: (body) =>
        withCluster(body, async (batchId, clusterId) => {
          const result = await store.update((doc) => {
            const batch = doc.batches[batchId];
            if (!batch) return { ok: false, error: `no batch ${batchId}` };
            return addNote(batch, clusterId, String(body.text ?? ""), Date.now());
          });
          if (!result.ok) throw new RunnerError(409, result.error);
          return { noted: true };
        }),

      brief: (body) =>
        withCluster(body, async (batchId, clusterId) => {
          const doc = await store.get();
          const batch = doc.batches[batchId];
          const cluster = batch ? clusterOf(batch, clusterId) : null;
          if (!cluster) throw new RunnerError(404, "this cluster is not in the batch any more");
          const cfg = await readConfig();
          return { text: `${briefFor(batch, cluster, await details(cfg, cluster.keys))}\n` };
        }),

      status: (body) =>
        withCluster(body, async (batchId, clusterId) => {
          // Asking is itself a sign of life, which is what clears a wait a
          // hook set: an agent that can run a command is not blocked on one.
          await store.update((d) => clusterSeen(d.batches[batchId], clusterId, Date.now()));
          const doc = await store.get();
          const batch = doc.batches[batchId];
          const cluster = batch ? clusterOf(batch, clusterId) : null;
          if (!cluster) throw new RunnerError(404, "this cluster is not in the batch any more");
          return {
            batch: batch.name,
            cluster: cluster.name,
            state: clusterState(batch, cluster),
            working: activeKey(batch, cluster),
            tickets: cluster.keys.map((key) => ({
              key,
              summary: batch.tickets[key]?.summary ?? "",
              state: batch.ticketStates[key]?.state ?? "queued",
            })),
          };
        }),
    };
  }

  // ---- Lifecycle ----

  async function start() {
    if (instance) await stop();
    const self = { stopped: false, sweepTimer: null, control: null, unsubscribe: null };
    instance = self;

    try {
      await installCli();
    } catch (err) {
      log(`could not install the jira-batch command: ${err.message}`);
    }

    const control = createControlServer({ socketPath, handlers: verbs(), log });
    try {
      await control.start();
      self.control = control;
    } catch (err) {
      log(`could not open the batch control socket: ${err.message}`);
    }

    if (host?.agentHooks?.subscribe) {
      self.unsubscribe = host.agentHooks.subscribe({
        events: HOOK_EVENTS,
        onEvent: (event) => {
          if (!event?.paneId) return;
          store
            .update((doc) => {
              for (const batch of Object.values(doc.batches)) {
                if (batch.archivedAt) continue;
                const result = hookEvent(batch, event.paneId, event.event, Date.now());
                if (result.ok) return result;
              }
              return { ok: false };
            })
            .catch((err) => log(`hook event failed: ${err.message}`));
        },
      });
    }

    if (host?.sessions?.list) {
      let sweeping = false;
      self.sweepTimer = setInterval(() => {
        if (sweeping || self.stopped) return;
        sweeping = true;
        sweep()
          .catch((err) => log(`liveness sweep failed: ${err?.stack ?? err}`))
          .finally(() => {
            sweeping = false;
          });
      }, SWEEP_MS);
      self.sweepTimer.unref?.();
    }
  }

  async function stop() {
    const self = instance;
    instance = null;
    if (!self) return;
    self.stopped = true;
    clearInterval(self.sweepTimer);
    try {
      self.unsubscribe?.();
    } catch {
      // Already unsubscribed by the host.
    }
    await self.control?.stop().catch(() => {});
  }

  return {
    start,
    stop,
    startClusters,
    handOffAdditional,
    sendFeedback,
    resume,
    stopCluster,
    closeCluster,
    removeWorktree,
    installCli,
    installQaSkillForUser,
    socketPath,
    cliPath,
    evidenceDir,
    buildClusterReport,
  };
}
