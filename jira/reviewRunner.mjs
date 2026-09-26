// Everything a ticket review does outside the document: find the repository a
// pull request belongs to, check the pull request out into a worktree, start
// one agent per task in a session of its own, answer the agents' `jira-review`
// verbs, and clean up.
//
// The batch runner's shape on purpose - record intent first, then make things,
// then tell the agent - so a failure part way leaves a task that says what
// broke rather than a terminal nobody knows about. The verbs are served on the
// batch runner's control socket (see extraVerbs there): one socket, one PATH
// entry, one way for an agent to reach the extension.
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodeReviewBrief, buildPreviewQaBrief, buildReviewBriefLine } from "./brief.mjs";
import { contentTypeOf, readImage, writeImage } from "./evidence.mjs";
import { findTicketLinks } from "./links.mjs";
import {
  MAX_EXTRA_SHOTS,
  PAGE_SHOTS,
  TASKS,
  closeReview,
  isRunning,
  markTaskFailed,
  markTaskStopped,
  pageSlug,
  recordCodeReport,
  recordQaReport,
  rememberRepoPath,
  setTaskWindow,
  setWorkspace,
  startTask,
} from "./reviewModel.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const QA_SKILL = "jira-review-qa";
const SKILL_REL = path.join(".claude", "skills", QA_SKILL);
const SWEEP_MS = 15_000;
const SEND_RETRIES = 12;
const SEND_DELAY_MS = 400;
const FETCH_TIMEOUT = 60_000;

export class ReviewError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// One session per task, not one window each in a shared session: the host can
// kill a session but not a single window, and Stop must stop exactly one agent.
export function sessionNameFor(key, task) {
  return `review-${key.toLowerCase()}-${task}`;
}

// An origin names owner/repo when its path ends in them: https and ssh forms,
// with or without .git, compared without case (GitHub ignores it).
export function originMatches(origin, owner, repo) {
  const cleaned = String(origin ?? "")
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  const tail = `${owner}/${repo}`.toLowerCase();
  return cleaned.endsWith(`/${tail}`) || cleaned.endsWith(`:${tail}`);
}

export function createReviewRunner({
  host,
  store,
  configDir,
  readConfig,
  issueDetail,
  settingsForRepo,
  getSettings,
  repoRoot,
  resolveLocation,
  storefrontPassword = async () => "",
  // The batch runner's socket and bin directory, read when an agent is
  // started - they exist once the batch runner has started.
  controlSocket,
  log = console.log,
}) {
  const evidenceDir = path.join(configDir, "jira", "evidence", "reviews");
  let sweepTimer = null;

  function git(args, cwd, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd, encoding: "utf8", timeout }, (err, stdout, stderr) => {
        if (err) {
          err.message = String(stderr || err.message).trim();
          reject(err);
        } else resolve(stdout);
      });
    });
  }

  async function exists(file) {
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  }

  function requireHost() {
    if (!host?.sessions?.create || !host?.sessions?.sendTextToWindow || !host?.sessions?.listPanes) {
      throw new ReviewError(501, "this perch is too old to start review agents - update it (needs host.sessions)");
    }
    if (!host?.worktrees?.create) throw new ReviewError(501, "this perch is too old to create worktrees - update it");
    if (!host?.agents?.launchCommand) throw new ReviewError(501, "this perch is too old to launch agents - update it");
  }

  async function sendToWindow(windowId, text) {
    for (let attempt = 0; ; attempt++) {
      try {
        await host.sessions.sendTextToWindow(windowId, text, true);
        return;
      } catch (err) {
        if (attempt >= SEND_RETRIES) throw err;
        await sleep(SEND_DELAY_MS);
      }
    }
  }

  // ---- Finding the repository ----

  async function originOf(dir) {
    try {
      return (await git(["remote", "get-url", "origin"], dir)).trim();
    } catch {
      return "";
    }
  }

  // The active window's repository first, then every repository the project
  // map names, then the path the user gave last time for this owner/repo.
  // Null when none of them is a checkout of it: the route then asks.
  async function locateRepo({ owner, repo, cwd }) {
    const candidates = [];
    const active = cwd ? await repoRoot(cwd) : null;
    if (active) candidates.push(active);
    try {
      const settings = await getSettings();
      const map = JSON.parse(typeof settings["jira.projectMap"] === "string" ? settings["jira.projectMap"] : "{}");
      if (map && typeof map === "object") {
        for (const dir of Object.keys(map)) {
          const root = await repoRoot(dir).catch(() => null);
          if (root && !candidates.includes(root)) candidates.push(root);
        }
      }
    } catch {
      // An unreadable map is the same as an empty one here.
    }
    const remembered = (await store.get()).repoPaths[`${owner}/${repo}`.toLowerCase()];
    if (remembered && !candidates.includes(remembered)) candidates.push(remembered);

    for (const dir of candidates) {
      if (originMatches(await originOf(dir), owner, repo)) return dir;
    }
    return null;
  }

  // A path the user typed or picked, held to the same test before it is
  // remembered: reviewing the wrong repository's code would be worse than
  // asking again.
  async function acceptRepoPath(given, { owner, repo }) {
    const root = await repoRoot(given);
    if (!root) throw new ReviewError(400, `${given} is not inside a git repository`);
    const origin = await originOf(root);
    if (!originMatches(origin, owner, repo)) {
      throw new ReviewError(400, `${root} is a checkout of ${origin || "a repository with no origin"}, not ${owner}/${repo}`);
    }
    await store.update((doc) => rememberRepoPath(doc, `${owner}/${repo}`, root));
    return root;
  }

  // ---- The pull request's checkout ----

  // refs/pull/<n>/head is on the base repository for every pull request,
  // forks included, so this needs neither gh nor a remote per fork. The
  // branch is the extension's own and is force-updated on every run, so a
  // review started again sees the pull request as it is now.
  async function prepareWorktree(review, repoPath, pr) {
    const branch = `review/pr-${pr.number}`;
    if (review?.worktreePath && (await exists(review.worktreePath))) {
      await git(["fetch", "origin", `pull/${pr.number}/head`], review.worktreePath, FETCH_TIMEOUT);
      await git(["reset", "--hard", "FETCH_HEAD"], review.worktreePath);
      return { path: review.worktreePath, branch };
    }
    try {
      await git(["fetch", "origin", `+pull/${pr.number}/head:${branch}`], repoPath, FETCH_TIMEOUT);
    } catch (err) {
      throw new ReviewError(502, `could not fetch pull request #${pr.number} from origin: ${err.message}`);
    }
    const settings = await settingsForRepo(repoPath);
    const template =
      typeof settings["jira.worktreeLocation"] === "string" && settings["jira.worktreeLocation"].trim()
        ? settings["jira.worktreeLocation"].trim()
        : "";
    try {
      const made = await host.worktrees.create({ cwd: repoPath, branch, mode: "existing", ...(template ? { location: template } : {}) });
      return { path: made.path, branch };
    } catch (err) {
      // A worktree left by an earlier review whose record was lost: reuse it.
      const target = resolveLocation(template || "{repo}/.worktrees/{branch}", repoPath, branch);
      if (err?.status === 409 && (await exists(target))) {
        await git(["reset", "--hard", branch], target);
        return { path: target, branch };
      }
      throw new ReviewError(typeof err?.status === "number" ? err.status : 500, `could not create the review worktree: ${err.message}`);
    }
  }

  // Written into the QA agent's folder and hidden from `git status` through
  // info/exclude - exactly that path, never the whole .claude directory.
  async function installSkill(dir) {
    const source = path.join(here, "skills", QA_SKILL, "SKILL.md");
    const target = path.join(dir, SKILL_REL, "SKILL.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(source, "utf8"));
    try {
      const common = (await git(["rev-parse", "--git-common-dir"], dir)).trim();
      const excludeFile = path.resolve(dir, common, "info", "exclude");
      const pattern = `/${SKILL_REL.split(path.sep).join("/")}/`;
      const current = await readFile(excludeFile, "utf8").catch(() => "");
      if (!current.split("\n").some((line) => line.trim() === pattern)) {
        await mkdir(path.dirname(excludeFile), { recursive: true });
        await appendFile(excludeFile, `${current === "" || current.endsWith("\n") ? "" : "\n"}${pattern}\n`);
      }
    } catch {
      // Not a git folder (the scratch folder), or a read-only .git.
    }
  }

  // ---- Links ----

  // The links as the ticket carries them now, falling back to the URL alone
  // when the comment it came from has been edited away since.
  function pickLink(list, url) {
    if (url) {
      const found = list.find((entry) => entry.url === url);
      if (found) return found;
      const parsed = findTicketLinks({ comments: [{ body: url }] });
      return parsed.prs[0] ?? parsed.previews[0] ?? null;
    }
    return list[0] ?? null;
  }

  async function ticket(key, cwd) {
    const cfg = await readConfig(cwd);
    if (!cfg.siteUrl || !cfg.email || !cfg.apiToken) throw new ReviewError(400, "jira is not configured");
    return issueDetail(cfg, key);
  }

  async function agentFor(agentId) {
    let id = agentId;
    if (!id && host?.agents?.list) id = (await host.agents.list())[0]?.id ?? "";
    if (!id) throw new ReviewError(400, "no agent is enabled in Settings -> AI Providers");
    const launch = await host.agents.launchCommand(id);
    if (!launch) throw new ReviewError(400, `"${id}" is not an agent this perch can launch`);
    return { id, launch };
  }

  // ---- Starting ----

  // tasks: ["code"], ["qa"] or both. Answers { needsRepo } instead of
  // starting when a code review's repository is not checked out anywhere
  // known; the pane asks the user and calls again with repoPath.
  async function start(key, { tasks, prUrl = "", previewUrl = "", agentId = "", cwd = "", repoPath = "" }) {
    requireHost();
    if (!ISSUE_KEY.test(key)) throw new ReviewError(400, "key must be an issue key like CAP-123");
    const wanted = TASKS.filter((task) => tasks?.includes(task));
    if (wanted.length === 0) throw new ReviewError(400, "tasks must name code, qa or both");

    const detail = await ticket(key, cwd);
    const links = findTicketLinks(detail);
    const pr = pickLink(links.prs, prUrl);
    const preview = pickLink(links.previews, previewUrl);
    if (wanted.includes("code") && !pr?.number) throw new ReviewError(400, `${key} has no pull request link to review`);
    if (wanted.includes("qa") && !preview?.themeId) throw new ReviewError(400, `${key} has no preview theme link to check`);
    for (const task of wanted) {
      if ((await store.get()).reviews[key]?.tasks?.[task]?.state === "running") {
        throw new ReviewError(409, `the ${task === "code" ? "code review" : "visual QA"} of ${key} is already running`);
      }
    }
    const agent = await agentFor(agentId);

    // Where the repository is. Required for a code review; for QA alone it is
    // context, so a miss falls back rather than asks. With a pull request the
    // repository is known and only its checkout counts - the active window's
    // may be anything. Without one, the active window's is the best guess.
    let repo = null;
    if (pr) {
      repo = repoPath ? await acceptRepoPath(repoPath, pr) : await locateRepo({ owner: pr.owner, repo: pr.repo, cwd });
      if (!repo && wanted.includes("code")) return { needsRepo: { owner: pr.owner, repo: pr.repo } };
    } else if (cwd) {
      repo = await repoRoot(cwd);
    }

    const now = Date.now();
    const started = await store.update((doc) => {
      for (const task of wanted) {
        const result = startTask(doc, key, task, { agentId: agent.id, prUrl: pr?.url ?? "", previewUrl: preview?.url ?? "", repo: repo ?? "" }, now);
        if (!result.ok) return result;
      }
      return { ok: true };
    });
    if (!started.ok) throw new ReviewError(409, started.error);

    // The checkout, for a code review, or when an earlier one is still there.
    let workspace = null;
    const existing = (await store.get()).reviews[key];
    if (wanted.includes("code")) {
      try {
        workspace = await prepareWorktree(existing, repo, pr);
      } catch (err) {
        await store.update((doc) => {
          for (const task of wanted) markTaskFailed(doc, key, task, err.message, Date.now());
          return { ok: true };
        });
        throw err;
      }
      await store.update((doc) => setWorkspace(doc, key, { worktreePath: workspace.path, branch: workspace.branch }, Date.now()));
    } else if (existing?.worktreePath && (await exists(existing.worktreePath))) {
      workspace = { path: existing.worktreePath, branch: existing.branch };
    }

    const scratch = path.join(configDir, "jira", "review-scratch", key);
    const cwdFor = { code: workspace?.path ?? "", qa: workspace?.path ?? repo ?? scratch };

    const results = await Promise.all(wanted.map((task) => launch(key, task, cwdFor[task], agent)));
    return { tasks: results, worktreePath: workspace?.path ?? "" };
  }

  async function launch(key, task, dir, agent) {
    const fail = async (message) => {
      await store.update((doc) => markTaskFailed(doc, key, task, message, Date.now()));
    };
    try {
      await mkdir(dir, { recursive: true });
      if (task === "qa") await installSkill(dir);
      const name = sessionNameFor(key, task);
      // A session left by a run that failed would hold the name.
      await host.sessions.kill?.(name).catch(() => {});
      const session = await host.sessions.create(name, dir, true);
      const pane = (await host.sessions.listPanes(session.name))[0];
      if (!pane) throw new Error(`session ${session.name} has no window`);
      await store.update((doc) => setTaskWindow(doc, key, task, { windowId: pane.id, cwd: dir }, Date.now()));
      const { socketPath, binDir } = controlSocket();
      const line =
        `export JB_SOCK=${shellQuote(socketPath)} JR_KEY=${shellQuote(key)} JR_TASK=${shellQuote(task)}; ` +
        `export PATH=${shellQuote(binDir)}:"$PATH"; ${agent.launch} ${shellQuote(buildReviewBriefLine({ key, task }))}`;
      await sendToWindow(pane.id, line);
      return { task, sessionName: session.name, windowId: pane.id, cwd: dir };
    } catch (err) {
      await fail(err.message);
      throw new ReviewError(500, `could not start the ${task === "code" ? "code review" : "visual QA"} agent: ${err.message}`);
    }
  }

  // ---- Stopping and closing ----

  async function stop(key, task) {
    if (!TASKS.includes(task)) throw new ReviewError(400, "task must be code or qa");
    await host?.sessions?.kill?.(sessionNameFor(key, task)).catch((err) => log(`could not kill ${sessionNameFor(key, task)}: ${err.message}`));
    const result = await store.update((doc) => markTaskStopped(doc, key, task, Date.now()));
    if (!result.ok) throw new ReviewError(404, result.error);
    return result;
  }

  // Removes the checkout and both sessions; the reports and screenshots stay.
  async function close(key) {
    const review = (await store.get()).reviews[key];
    if (!review) throw new ReviewError(404, `no review of ${key}`);
    if (isRunning(review)) throw new ReviewError(409, "stop the running agents first");
    for (const task of TASKS) await host?.sessions?.kill?.(sessionNameFor(key, task)).catch(() => {});
    if (review.worktreePath && review.repo && host?.worktrees?.remove) {
      try {
        await host.worktrees.remove({ cwd: review.repo, path: review.worktreePath, force: true });
      } catch (err) {
        if (err?.status !== 404) throw new ReviewError(500, `could not remove ${review.worktreePath}: ${err.message}`);
      }
    }
    await rm(path.join(configDir, "jira", "review-scratch", key), { recursive: true, force: true });
    const result = await store.update((doc) => closeReview(doc, key, Date.now()));
    if (!result.ok) throw new ReviewError(409, result.error);
    return { ok: true };
  }

  // A task whose window is gone did not report and never will.
  async function sweep() {
    if (!host?.sessions?.list) return;
    const live = new Set();
    try {
      for (const session of await host.sessions.list()) for (const window of session.windows ?? []) live.add(window.id);
    } catch (err) {
      log(`review sweep could not list sessions: ${err.message}`);
      return;
    }
    const doc = await store.get();
    for (const review of Object.values(doc.reviews)) {
      for (const task of TASKS) {
        const current = review.tasks[task];
        if (current?.state !== "running" || !current.windowId || live.has(current.windowId)) continue;
        await store.update((d) => markTaskFailed(d, review.key, task, "its terminal window is gone", Date.now()));
      }
    }
  }

  // ---- Evidence ----

  function shotPath(key, name, ext) {
    return path.join(evidenceDir, key, `${name}.${ext}`);
  }

  // Validated in full before anything is written or removed: a refused image
  // must leave the previous report's screenshots as they were.
  async function storeQaImages(key, pages) {
    const read = [];
    const out = [];
    const taken = new Set();
    for (const [i, page] of (Array.isArray(pages) ? pages : []).entries()) {
      const slug = pageSlug(page?.page, taken);
      taken.add(slug);
      const entry = { page: String(page?.page ?? "/"), slug, images: {}, extras: [] };
      for (const which of PAGE_SHOTS) {
        const file = page?.[which];
        entry.images[which] = null;
        if (file) read.push({ entry, which, name: `${slug}-${which}`, image: await readImage(`${which} (page ${i + 1})`, String(file)) });
      }
      const shots = Array.isArray(page?.shots) ? page.shots : [];
      if (shots.length > MAX_EXTRA_SHOTS) throw new ReviewError(400, `--shot given ${shots.length} times on ${entry.page}, over the limit of ${MAX_EXTRA_SHOTS}`);
      for (const [n, shot] of shots.entries()) {
        const label = `shot-${n + 1}`;
        const extra = { label, caption: String(shot?.caption ?? "").slice(0, 120) };
        entry.extras.push(extra);
        read.push({ extra, name: `${slug}-${label}`, image: await readImage(`shot (page ${i + 1})`, String(shot?.file ?? "")) });
      }
      out.push(entry);
    }
    await rm(path.join(evidenceDir, key), { recursive: true, force: true });
    for (const item of read) {
      const stored = await writeImage(path.join(evidenceDir, key), item.name, item.image);
      if (item.extra) item.extra.ext = stored.ext;
      else item.entry.images[item.which] = stored;
    }
    return out;
  }

  // The file behind one screenshot, for the route that serves it. `name` is
  // checked against the stored report, never passed through.
  async function shotFile(key, slug, which) {
    const review = (await store.get()).reviews[key];
    const page = review?.tasks?.qa?.report?.pages?.find((p) => p.slug === slug);
    if (!page) return null;
    const image = PAGE_SHOTS.includes(which) ? page.images[which] : page.extras.find((e) => e.label === which);
    if (!image?.ext) return null;
    return { file: shotPath(key, `${slug}-${which}`, image.ext), type: contentTypeOf(image.ext) };
  }

  // ---- The agent's verbs ----

  function taskOf(body, expected) {
    const key = String(body.key ?? "").toUpperCase();
    const task = String(body.task ?? "");
    if (!ISSUE_KEY.test(key) || !TASKS.includes(task)) {
      throw new ReviewError(400, "this shell is not a review agent's - start the review from the ticket in Perch");
    }
    if (expected && task !== expected) {
      throw new ReviewError(400, `this is the ${task === "code" ? "code review" : "visual QA"} agent's shell; use \`jira-review ${task}\``);
    }
    return { key, task };
  }

  async function briefText(key, task) {
    const review = (await store.get()).reviews[key];
    if (!review) throw new ReviewError(404, `no review of ${key}`);
    const detail = await ticket(key, review.repo || undefined);
    const links = findTicketLinks(detail);
    if (task === "code") {
      const pr = pickLink(links.prs, review.prUrl);
      if (!pr) throw new ReviewError(404, `${key} no longer has the pull request link ${review.prUrl}`);
      return buildCodeReviewBrief({ detail, pr, worktreePath: review.worktreePath });
    }
    const preview = pickLink(links.previews, review.previewUrl);
    if (!preview) throw new ReviewError(404, `${key} no longer has the preview link ${review.previewUrl}`);
    const password = await storefrontPassword(key.split("-")[0]);
    return buildPreviewQaBrief({
      detail,
      preview,
      liveOrigin: preview.kind === "preview" ? preview.origin : "",
      pages: preview.path && preview.path !== "/" ? [preview.path] : [],
      password,
    });
  }

  function verbs() {
    return {
      "review-brief": async (body) => {
        const { key, task } = taskOf(body);
        return { text: `${await briefText(key, task)}\n` };
      },
      "review-status": async (body) => {
        const { key, task } = taskOf(body);
        const current = (await store.get()).reviews[key]?.tasks?.[task];
        return { key, task, state: current?.state ?? "none" };
      },
      "review-code": async (body) => {
        const { key } = taskOf(body, "code");
        const findings = (Array.isArray(body.findings) ? body.findings : []).map((f) => ({
          severity: f?.severity,
          file: f?.file,
          line: Number.isFinite(Number(f?.line)) && f?.line !== "" ? Number(f.line) : null,
          text: f?.text,
        }));
        const result = await store.update((doc) => recordCodeReport(doc, key, { verdict: body.verdict, summary: body.summary, findings }, Date.now()));
        if (!result.ok) throw new ReviewError(409, result.error);
        return { key, verdict: result.verdict, findings: result.findings };
      },
      "review-qa": async (body) => {
        const { key } = taskOf(body, "qa");
        const current = (await store.get()).reviews[key]?.tasks?.qa;
        // Checked before the images are copied, so a late report cannot
        // replace the screenshots of the one that stands.
        if (current?.state !== "running") throw new ReviewError(409, `the qa task of ${key} is ${current?.state ?? "not started"}, not running`);
        const pages = await storeQaImages(key, body.pages);
        const result = await store.update((doc) =>
          recordQaReport(doc, key, { status: body.status, checked: body.checked, wrong: body.wrong, notes: body.notes, pages }, Date.now()),
        );
        if (!result.ok) throw new ReviewError(409, result.error);
        return { key, status: result.status, pages: result.pages };
      },
    };
  }

  function startSweep() {
    if (sweepTimer || !host?.sessions?.list) return;
    let sweeping = false;
    sweepTimer = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      sweep()
        .catch((err) => log(`review sweep failed: ${err?.stack ?? err}`))
        .finally(() => {
          sweeping = false;
        });
    }, SWEEP_MS);
    sweepTimer.unref?.();
  }

  function stopSweep() {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  return { start, stop, close, sweep, verbs, shotFile, locateRepo, startSweep, stopSweep, evidenceDir };
}
