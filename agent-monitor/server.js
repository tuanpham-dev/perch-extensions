// agent-monitor server hook: lists every terminal window running one of the
// agents in core's registry and classifies each as working/waiting/done/idle —
// the source for the PROJECTS-pane window-row status dot. Windows come from
// host.sessions.list(), so this works on whichever terminal backend runs
// them (the bundled daemon or the tmux backend). Detection is Orca-style
// dual-signal:
//
//   1. an agent hook event from core's pipeline
//      (host.agentHooks.subscribe), keyed by the window it fired in. The
//      authoritative signal while fresh - the mapping and the 30-minute
//      freshness window are Orca's, see hookStatus.mjs.
//   2. else the window's title, but only when the backend supplies one and
//      it actually says something (the host window record carries no title
//      today, so this step is dormant until it does):
//      Claude Code sets an OSC title of "<glyph> <task>". A rotating
//      quarter-circle glyph (◐◑◓◒) means working. "✳" does NOT mean idle —
//      re-checked live on 2026-09-10 against a pane that was busy running
//      tools for minutes, where the title sat at "✳ Status bar additions"
//      the whole time (12 samples over 5s, never once a quarter-circle). It
//      is Claude's own mark, not a spinner, so it yields only the task
//      LABEL and the state falls through to step 3. Same for any other
//      glyph — a title's shape is never invented into a state.
//   3. else the pane's own Claude session transcript's mtime: written
//      within the threshold -> working, else done, and idle after 30 quiet
//      minutes (hookStatus.mjs's classifyQuiet). The session is the one
//      whose CLI was started in this window (claudePanes.mjs); only a window
//      with no such CLI falls back to the cwd's most recent transcript. No
//      transcript at all (a non-Claude agent) -> idle.
//
// Never writes into a window — read-only session-list/filesystem queries only.
//
// Both halves used to be this extension's own: a duplicated "what is an
// agent" setting, and a pasted hooks snippet curling a route of its own
// (which carried no auth header and only worked because a request with no
// Origin passes the gate). Core owns both now — the registry in Settings →
// AI Providers, and the hook pipeline that installs, receives and normalizes
// events — so this file consumes them instead
// (plans/agent-platform-core.md). Keying on the pane rather than on
// Claude's own session_id is what makes the hook path work for Codex and
// Antigravity at all: neither sends a session id.
import { claudeSessionsByWindow } from "./claudePanes.mjs";
import { classifyFromHook, classifyQuiet, reduceHookEvent } from "./hookStatus.mjs";
import { resolveProject } from "./projects.mjs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CLAUDE_PROJECTS_DIR = path.join(homedir(), ".claude", "projects");

// ---- Window listing: core's own session list, one entry per real window
// (a window is one terminal), with the stable window id hook events are
// keyed by. `paneId` keeps its name because that is the key the rest of this
// file and hookStatus.mjs use for "the terminal an event came from". ----

// Which program runs in each window of a session. Matching the window's
// foreground command alone misses every agent whose CLI is a script: an
// npm-installed `codex` is `node .../codex`, so its window reports "node" (or
// "node-MainThread" on an older daemon) and never "codex".
// host.agents.forSession() also matches a descendant process named after an
// agent's program - the native binary that script starts - and returns the
// program it matched, which is what everything below keys on.
//
// That answer costs a scan of every process on the host, which on a busy
// machine is seconds, so it is asked for as little as possible: never for a
// window whose foreground command already names an agent (the common case,
// answered the old way for free), and otherwise remembered per window and
// foreground command. What runs under a window changes when its foreground
// command does, so a changed command is a new key and gets a fresh answer at
// once; the TTL only bounds how long an agent started in the background of a
// shell prompt can go unnoticed.
//
// A core without host.agents.forSession gets the foreground match this used
// to be, so an older install loses nothing.
const WINDOW_AGENT_TTL_MS = 30_000;
const windowAgentCache = new Map(); // `${windowId}\n${command}` -> { at, program }

function windowAgentKey(win) {
  return `${win.id}\n${win.command}`;
}

function pruneWindowAgentCache(now) {
  for (const [key, entry] of windowAgentCache) {
    if (now - entry.at >= WINDOW_AGENT_TTL_MS) windowAgentCache.delete(key);
  }
}

async function agentProgramsBySession(host, session, programs, now) {
  const byIndex = new Map();
  const unknown = [];
  for (const win of session.windows ?? []) {
    if (programs.includes(win.command)) {
      byIndex.set(win.index, win.command);
      continue;
    }
    const known = windowAgentCache.get(windowAgentKey(win));
    if (known) {
      if (known.program && programs.includes(known.program)) byIndex.set(win.index, known.program);
      continue;
    }
    unknown.push(win);
  }
  if (unknown.length === 0 || typeof host.agents?.forSession !== "function") return byIndex;
  let found;
  try {
    found = new Map((await host.agents.forSession(session.name)).map((w) => [w.windowIndex, w.program]));
  } catch {
    // A session that vanished mid-listing, or a scan that failed: leave its
    // unknown windows unmatched for this poll and ask again on the next.
    return byIndex;
  }
  for (const win of unknown) {
    const program = found.get(win.index) ?? null;
    windowAgentCache.set(windowAgentKey(win), { at: now, program });
    if (program && programs.includes(program)) byIndex.set(win.index, program);
  }
  return byIndex;
}

async function listAgentPanes(host, programs) {
  let sessions;
  try {
    sessions = await host.sessions.list();
  } catch {
    return [];
  }
  const now = Date.now();
  pruneWindowAgentCache(now);
  const perSession = await Promise.all(
    sessions.map(async (session) => ({ session, byIndex: await agentProgramsBySession(host, session, programs, now) })),
  );
  const panes = [];
  for (const { session, byIndex } of perSession) {
    for (const win of session.windows ?? []) {
      const program = byIndex.get(win.index);
      if (!program) continue;
      panes.push({
        paneId: win.id,
        sessionName: session.name,
        windowIndex: win.index,
        windowName: win.name,
        // The AGENT's program, not the window's foreground command: for a
        // script CLI those differ, and the agent is what the rest of this
        // file (and the board's card) is about.
        command: program,
        cwd: win.cwd || session.path,
        // The host window record carries no title (see the header); an
        // empty one makes parseAgentTitle return null, so the title rule
        // simply falls through.
        title: win.title ?? "",
      });
    }
  }
  return panes;
}

// ---- Claude project-dir / session-id resolution (ported from core's
// subagentWatcher.ts / extensions/subagent-viewer/server.js — extensions
// can't import each other) ----

function cwdToProjectDirName(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

async function mostRecentSessionId(projectDir) {
  let entries;
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }
  const jsonlNames = entries.filter((e) => e.endsWith(".jsonl") && !e.includes("/"));
  let best = null;
  for (const name of jsonlNames) {
    try {
      const s = await stat(path.join(projectDir, name));
      const id = name.slice(0, -".jsonl".length);
      if (!best || s.mtimeMs > best.mtimeMs) best = { id, mtimeMs: s.mtimeMs };
    } catch {
      // Skip — vanished mid-scan.
    }
  }
  return best;
}

const SESSION_ID_TTL_MS = 15_000;
const sessionIdCache = new Map();

// Which session file to watch is worth caching — a readdir + a stat per
// entry, and the answer only changes when a new session starts. Its MTIME is
// not: that number IS the working/done signal, and a cached one made the
// state up to SESSION_ID_TTL_MS stale on top of the threshold, so a pane
// that had just written its transcript still read as finished for
// the rest of the TTL. The id comes from the cache; the mtime is re-stat'd
// every call, which is one stat on a known path.
async function mostRecentSessionCached(projectDir) {
  const cached = sessionIdCache.get(projectDir);
  let value = cached && Date.now() - cached.at < SESSION_ID_TTL_MS ? cached.value : undefined;
  if (value === undefined) {
    value = await mostRecentSessionId(projectDir);
    sessionIdCache.set(projectDir, { at: Date.now(), value });
  }
  if (!value) return value;
  try {
    const fresh = await stat(path.join(projectDir, `${value.id}.jsonl`));
    return { id: value.id, mtimeMs: fresh.mtimeMs };
  } catch {
    // Vanished (a cleared session) — drop the cache entry so the next call
    // re-resolves rather than reporting a file that is gone.
    sessionIdCache.delete(projectDir);
    return null;
  }
}

// ---- Pane-title classification (see this file's header for the captured
// evidence) ----

const WORKING_GLYPHS = new Set(["◐", "◑", "◓", "◒"]);
// Claude Code's own mark in the title. Present whether it's working or
// waiting (see classifyPane's step 2), so it identifies the agent and the
// task text — never the state.
const CLAUDE_GLYPH = "✳";

// Splits "<glyph> <rest>" into { glyph, label }, or null if the title
// doesn't have that shape at all (a non-Claude agent, or a blank/default
// terminal title like "code-server").
function parseAgentTitle(title) {
  if (!title) return null;
  const m = /^(\S+)\s+(.*)$/.exec(title.trim());
  if (!m) return null;
  return { glyph: m[1], label: m[2] };
}

// ---- Hook events — keyed by window id, so two agent windows sharing a cwd
// can't cross-contaminate each other's state, and so an agent that sends no
// session id of its own (Codex, Antigravity) is served just as well as
// Claude Code ----

const MAX_HOOK_EVENTS = 200;
const hookEvents = new Map(); // paneId -> record from hookStatus.mjs's reduceHookEvent

function recordHookEvent(event) {
  const paneId = event.paneId;
  if (!paneId) return;
  const next = reduceHookEvent(hookEvents.get(paneId), event);
  if (!next) return;
  if (hookEvents.size >= MAX_HOOK_EVENTS && !hookEvents.has(paneId)) {
    const oldestKey = hookEvents.keys().next().value;
    if (oldestKey !== undefined) hookEvents.delete(oldestKey);
  }
  hookEvents.set(paneId, next);
}

// ---- Classification ----

// The transcript for this pane's own session. Two Claude panes in one
// directory share a project dir, so "its most recent transcript" is whichever
// session wrote last - both panes would read that one session's activity.
// Claude Code's transcripts are the only ones this reads, so only a Claude
// window may be classified from one. Without this guard a Codex window fell
// through to the folder's newest CLAUDE transcript and showed as working
// whenever a Claude session in the same checkout wrote to its own - latent
// while script CLIs went undetected, and the first thing detecting them
// would have surfaced. A non-Claude agent with no hooks is idle, as the
// README says.
const TRANSCRIPT_PROGRAM = "claude";

async function paneTranscript(pane) {
  if (pane.command !== TRANSCRIPT_PROGRAM) return null;
  const own = (await claudeSessionsByWindow()).get(pane.paneId);
  if (own) {
    const projectDir = path.join(CLAUDE_PROJECTS_DIR, cwdToProjectDirName(own.cwd ?? pane.cwd));
    try {
      const s = await stat(path.join(projectDir, `${own.sessionId}.jsonl`));
      return { id: own.sessionId, mtimeMs: s.mtimeMs };
    } catch {
      // Recorded but nothing written yet (a brand-new session).
      return null;
    }
  }
  return mostRecentSessionCached(path.join(CLAUDE_PROJECTS_DIR, cwdToProjectDirName(pane.cwd)));
}

async function classifyPane(pane, waitingThresholdMs) {
  const session = await paneTranscript(pane);
  const transcriptMtime = session?.mtimeMs ?? null;

  // 1. Hook evidence for this pane, while it is fresh (hookStatus.mjs). It
  // is authoritative: a transcript write or a title glyph never overrides it,
  // because anything the agent goes on to do sends its own event. The
  // transcript-grace comparison this used to make is gone with the reason
  // for it - it existed to tell "the turn's last flush" from "working
  // again", and with the hook as the authority there is nothing to tell.
  //
  // The title still contributes the task label, the one thing a hook event
  // does not carry.
  const parsed = parseAgentTitle(pane.title);
  const taskLabel = parsed && (WORKING_GLYPHS.has(parsed.glyph) || parsed.glyph === CLAUDE_GLYPH)
    ? parsed.label
    : undefined;
  const fromHook = classifyFromHook(hookEvents.get(pane.paneId));
  if (fromHook) return { ...fromHook, taskLabel };

  // 2. Pane-title spinner rule — a quarter-circle is the one glyph that
  // actually reports a state. Everything else (Claude's own "✳" mark
  // included) contributes the task label and nothing more.
  if (parsed && WORKING_GLYPHS.has(parsed.glyph)) {
    return { state: "working", taskLabel, lastActivityAt: transcriptMtime };
  }

  // 3. Transcript-mtime fallback — the signal that survives, since Claude
  // Code writes its transcript continuously while it works. A stale hook
  // record still says whether the last turn finished (hookStatus.mjs).
  return { ...classifyQuiet(hookEvents.get(pane.paneId), transcriptMtime, waitingThresholdMs), taskLabel };
}

// Shorter than the client's own poll beat, so a burst of requests shares
// one classification without a later tick reusing it. Keyed by pane, never
// by cwd: a cwd key handed the first pane's state, task label and hook
// record to every other agent pane in the same directory.
const CLASSIFY_CACHE_TTL_MS = 2_000;
const classifyCache = new Map(); // paneId -> { at, value }

async function classifyPaneCached(pane, waitingThresholdMs) {
  const cached = classifyCache.get(pane.paneId);
  if (cached && Date.now() - cached.at < CLASSIFY_CACHE_TTL_MS) return cached.value;
  const value = await classifyPane(pane, waitingThresholdMs);
  classifyCache.set(pane.paneId, { at: Date.now(), value });
  return value;
}

// Which panes count as agents: core's registry (Settings → AI Providers), and
// nothing else. This extension had its own agentMonitor.programs setting
// until the migration; it is gone rather than deprecated, so there is exactly
// one place an agent is named.
//
// Two answers come out of the one call: the programs to match panes against
// (the status marks' only need), and what to CALL the agent that matched -
// its label and its own mark - which is what a board card shows instead of
// the bare foreground command.
async function resolveAgentIndex(host) {
  // Optional-called: a core without the registry has no host.agents, and
  // throwing here would take the whole route down. It simply has no agents
  // then - there is no older list to fall back to.
  let agents = null;
  try {
    agents = (await host.agents?.list()) ?? null;
  } catch (err) {
    console.warn("agent-monitor: could not read the agent registry:", err.message);
  }
  const programs = [];
  const byProgram = new Map();
  for (const agent of agents ?? []) {
    // An entry with no foreground command is a launch preset only and can
    // never match a pane.
    if (!agent?.program) continue;
    programs.push(agent.program);
    // Two presets can share one CLI; the first in the user's own order wins,
    // the same way the registry itself resolves a duplicate.
    if (!byProgram.has(agent.program)) {
      byProgram.set(agent.program, {
        id: agent.id ?? "",
        label: agent.label ?? agent.program,
        iconUrl: agent.iconUrl ?? "",
        icon: agent.icon ?? "",
      });
    }
  }
  return { programs, byProgram };
}

// One project lookup per distinct folder, not per pane: several windows in
// one checkout are the common case, and each lookup is a git call behind a
// cache of its own (projects.mjs).
async function resolveProjects(host, panes) {
  const dirs = [...new Set(panes.map((pane) => pane.cwd).filter(Boolean))];
  const entries = await Promise.all(dirs.map(async (dir) => [dir, await resolveProject(host, dir)]));
  return new Map(entries);
}

const NO_PROJECT = { repo: "", project: "", branch: null, linked: false };

export function activate({ router, getSettings, host }) {
  // Core installs the hooks (Settings → AI Providers), receives every event at one
  // endpoint and normalizes it; all this extension does is remember the last
  // state per pane. The subscription is dropped for us when this server hook
  // unmounts, so there is nothing to tear down here.
  //
  // Optional-called for the same reason as host.agents above: on a core
  // without the pipeline this has to be a no-op, not a throw. An exception
  // here would abort activate() and leave the extension with no routes at
  // all, which would cost the title and transcript signals too — the ones
  // that never needed hooks.
  host.agentHooks?.subscribe({
    events: ["session-start", "prompt-submit", "tool-start", "tool-end", "permission", "stop"],
    onEvent(event) {
      recordHookEvent(event);
    },
  });

  router.get("/agents", async (_req, res) => {
    try {
      const settings = await getSettings();
      const { programs, byProgram } = await resolveAgentIndex(host);
      const thresholdSeconds = Number(settings["agentMonitor.waitingThresholdSeconds"]);
      const waitingThresholdMs = (Number.isFinite(thresholdSeconds) && thresholdSeconds > 0 ? thresholdSeconds : 45) * 1000;

      const panes = await listAgentPanes(host, programs);
      const projects = await resolveProjects(host, panes);
      const rows = await Promise.all(
        panes.map(async (pane) => {
          const classification = await classifyPaneCached(pane, waitingThresholdMs);
          const agent = byProgram.get(pane.command);
          const project = projects.get(pane.cwd) ?? NO_PROJECT;
          return {
            sessionName: pane.sessionName,
            windowIndex: pane.windowIndex,
            windowName: pane.windowName,
            command: pane.command,
            cwd: pane.cwd,
            // The window's own stable id. The board's saved card order is
            // keyed by it, because a session rename or a window renumber
            // changes sessionName:windowIndex and this never moves.
            paneId: pane.paneId,
            agentId: agent?.id ?? "",
            agentLabel: agent?.label ?? pane.command,
            iconUrl: agent?.iconUrl ?? "",
            icon: agent?.icon ?? "",
            repo: project.repo,
            project: project.project,
            branch: project.branch,
            linked: project.linked,
            ...classification,
          };
        }),
      );
      res.json({ agents: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Which project a folder belongs to, for a folder with no agent running in
  // it: the board's "This project" scope follows the active tab, which is
  // routinely a plain shell or an editor with no agent anywhere near it, so
  // it cannot learn the repository from the rows above.
  router.get("/project", async (req, res) => {
    const cwd = typeof req.query?.cwd === "string" ? req.query.cwd.trim() : "";
    if (!cwd) {
      res.status(400).json({ error: "cwd is required" });
      return;
    }
    try {
      res.json(await resolveProject(host, cwd));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
