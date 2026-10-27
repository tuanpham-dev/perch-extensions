// Claude Code's usage, from what the CLI already writes locally:
//
//   ~/.claude/projects/<project>/<session>.jsonl   per-message token usage,
//       plus a cost-state summary line (see ../costState.mjs), plus
//       <session>/subagents/*.jsonl for the subagent runs, whose tokens
//       appear nowhere in the parent's lines
//   ~/.claude/rate-limit-state.json                the 5-hour and weekly
//       percentages Claude Code itself records, refreshed the most often
//   ~/.claude.json                                 the CLI's cached copy of
//       the account's limits (see ./claudeConfig.mjs), which is where the
//       per-model weekly caps live
//   ~/.claude/sessions/<pid>.json                  which CLI runs in which
//       terminal window (see ../claudePanes.mjs)
//
// Only transcripts touched inside the window on screen are parsed line by
// line, and each only for what was appended since the last refresh (see
// ../appendedLines.mjs); everything else is read as a tail for its cost line,
// again only once it changes. Nothing here writes.
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { blocksFor, parseUsageLines } from "../usageModel.mjs";
import { readAppendedLines } from "../appendedLines.mjs";
import { readCostState, readTail, spendFrom } from "../costState.mjs";
import { readWindows } from "./claudeConfig.mjs";
import { refreshFromCli } from "./claudeCli.mjs";

const CLAUDE_DIR = path.join(homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const RATE_LIMIT_STATE = path.join(CLAUDE_DIR, "rate-limit-state.json");
const SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");

// How many blocks back the view can show; only files touched inside that
// span are parsed for per-message usage.
const BLOCKS_SHOWN = 6;

// Session files are left behind by CLIs that exited (hundreds accumulate), so
// one only counts while its process is alive.
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, it just isn't ours to signal.
    return err?.code === "EPERM";
  }
}

export const id = "claude";
export const label = "Claude Code";
// The registry program core matches windows on, which is how a window core
// resolved gets routed back to this reader.
export const program = "claude";

export async function available() {
  try {
    return (await stat(PROJECTS_DIR)).isDirectory();
  } catch {
    return false;
  }
}

// Every transcript, parent sessions and subagent runs alike, with the mtime
// the window filter needs and the size the incremental reads go by.
async function listTranscripts() {
  const out = [];
  let projects;
  try {
    projects = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  await Promise.all(
    projects
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const projectDir = path.join(PROJECTS_DIR, entry.name);
        let children;
        try {
          children = await readdir(projectDir, { withFileTypes: true });
        } catch {
          return;
        }
        await Promise.all(
          children.map(async (child) => {
            const full = path.join(projectDir, child.name);
            if (child.isFile() && child.name.endsWith(".jsonl")) {
              const info = await statOf(full);
              if (info) out.push({ file: full, ...info });
              return;
            }
            if (!child.isDirectory()) return;
            const subagents = path.join(full, "subagents");
            let names;
            try {
              names = await readdir(subagents);
            } catch {
              return;
            }
            await Promise.all(
              names
                .filter((name) => name.endsWith(".jsonl"))
                .map(async (name) => {
                  const file = path.join(subagents, name);
                  const info = await statOf(file);
                  if (info) out.push({ file, ...info });
                }),
            );
          }),
        );
      }),
  );
  return out;
}

async function statOf(file) {
  try {
    const { mtimeMs, size } = await stat(file);
    return { mtime: mtimeMs, size };
  } catch {
    return null; // vanished between listing and stat
  }
}

async function mtimeOf(file) {
  return (await statOf(file))?.mtime ?? null;
}

// Per transcript: how far it has been read, the usage entries found so far,
// and the dedupe keys behind them. Dropped once a file leaves the window.
const parsed = new Map();

async function entriesOf({ file, size }) {
  let state = parsed.get(file);
  // Smaller than what was read: the file was replaced, so start over.
  if (!state || size < state.offset) {
    state = { offset: 0, entries: [], seen: new Set() };
    parsed.set(file, state);
  }
  const offset = await readAppendedLines(file, state.offset, size, (text) => {
    for (const entry of parseUsageLines(text, state.seen)) state.entries.push(entry);
  });
  if (offset === null) return null;
  state.offset = offset;
  return state.entries;
}

// Each transcript's cost-state record, read again only once the file changed.
const costs = new Map();

async function costOf({ file, mtime, size }) {
  const cached = costs.get(file);
  if (cached && cached.mtime === mtime && cached.size === size) return cached.record;
  const record = await readCostState(file);
  costs.set(file, { mtime, size, record });
  return record;
}

function forgetAllBut(cache, files) {
  for (const file of cache.keys()) if (!files.has(file)) cache.delete(file);
}

// The percentages and reset times Claude Code records for itself. A window
// whose reset has passed describes a window that no longer exists, so it is
// dropped rather than shown stale.
//
// Two sources, in that order: the statusline file, which is rewritten every
// time the status line draws and so is the freshest thing on disk, then the
// CLI's own cached account limits, which lag by minutes but carry the
// per-model weeks - and carry the session and week too, on a machine whose
// status line doesn't write that file at all.
//
// Both only move while a CLI runs, so the CLI is asked to run first: once a
// minute `claude -p /usage` rewrites them (see ./claudeCli.mjs), and the
// read that asked waits for it, so it sees the fresh files.
async function readLimits(now) {
  await refreshFromCli();
  const limits = await readStatuslineLimits(now);
  for (const window of await readWindows(now)) {
    if (!limits.some((l) => l.label === window.label)) limits.push(window);
  }
  return limits;
}

async function readStatuslineLimits(now) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(RATE_LIMIT_STATE, "utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const limits = [];
  const add = (windowLabel, pct, resetsAtSeconds) => {
    if (typeof pct !== "number") return;
    const resetsAt = typeof resetsAtSeconds === "number" ? resetsAtSeconds * 1000 : null;
    if (resetsAt !== null && resetsAt <= now) return;
    limits.push({ label: windowLabel, usedPercent: pct, resetsAt });
  };
  add("5-hour", parsed.five_hour_pct, parsed.resets_at);
  add("weekly", parsed.seven_day_pct, parsed.seven_day_resets_at);
  return limits;
}

// One pass over the transcripts at a time: two refreshes reading the same
// file into the same state at once would each add the other's lines.
let reading = null;

function readTranscripts(windowStart) {
  reading ??= (async () => {
    const transcripts = await listTranscripts();
    const recent = transcripts.filter((t) => t.mtime >= windowStart);
    forgetAllBut(parsed, new Set(recent.map((t) => t.file)));
    forgetAllBut(costs, new Set(transcripts.map((t) => t.file)));
    // One file after another: the reads yield between chunks, and running
    // them all at once would only hold every file's chunk in memory together.
    const entries = [];
    let unreadable = 0;
    for (const transcript of recent) {
      const found = await entriesOf(transcript);
      if (found === null) unreadable += 1;
      else for (const entry of found) entries.push(entry);
    }
    // Dated by last activity, not by when the session opened — see spendFrom.
    const costRecords = await Promise.all(
      transcripts.map(async (t) => {
        const record = await costOf(t);
        return record ? { ...record, at: t.mtime } : null;
      }),
    );
    return { entries, unreadable, costRecords: costRecords.filter(Boolean) };
  })().finally(() => {
    reading = null;
  });
  return reading;
}

export async function usage({ now, blockMs }) {
  const notes = [];
  const windowStart = now - BLOCKS_SHOWN * blockMs;
  const { entries, unreadable, costRecords } = await readTranscripts(windowStart);
  if (unreadable > 0) notes.push(`${unreadable} transcript(s) could not be read`);
  const spend = spendFrom(costRecords, now);
  const limits = await readLimits(now);

  const blocks = blocksFor(entries, now, blockMs)
    .sort((a, b) => b.start - a.start)
    .slice(0, BLOCKS_SHOWN);
  // The current block ends when the limit window resets, not blockMs after
  // its first entry — that is the number the user is actually waiting on.
  const current = blocks.find((b) => b.isCurrent);
  const fiveHour = limits.find((l) => l.label === "5-hour");
  if (current && fiveHour?.resetsAt) current.end = fiveHour.resetsAt;

  return { blocks, limits, spend, notes };
}

// Claude Code writes one ~/.claude/sessions/<pid>.json per running CLI,
// carrying that CLI's current sessionId. Core hands over the agent's pid, so
// the session is a direct lookup - no process walking and no window ids,
// which is what used to make this Linux-only and tmux-only.
async function sessionForPid(pid) {
  if (!Number.isFinite(pid) || !isPidAlive(pid)) return null;
  try {
    const record = JSON.parse(await readFile(path.join(SESSIONS_DIR, `${pid}.json`), "utf8"));
    return typeof record?.sessionId === "string" ? record : null;
  } catch {
    return null; // mid-write, or a CLI that keeps no session file
  }
}

// The model the Claude session in this window is using, from the most recent
// assistant line of its transcript, with how much context that turn sent:
// { model, contextTokens, contextWindow: null } (the window isn't recorded in
// the transcript; the server fills it in from contextWindow.mjs).
export async function modelFor({ pid }) {
  const session = await sessionForPid(pid);
  if (!session) return null;
  const file = await transcriptFor(session.sessionId);
  if (!file) return null;
  // Tail only: the live session's transcript is the biggest file here, and
  // the model in use is on its most recent assistant line.
  const text = await readTail(file);
  if (text === null) return null;
  return latestModel(parseUsageLines(text));
}

// The newest entry with a known model, as modelFor reports it. A turn's
// context is everything it sent: new input plus cache reads and writes.
export function latestModel(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.model === "unknown") continue;
    return { model: e.model, contextTokens: e.input + e.cacheRead + e.cacheCreation, contextWindow: null };
  }
  return null;
}

async function transcriptFor(sessionId) {
  let projects;
  try {
    projects = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue;
    const file = path.join(PROJECTS_DIR, entry.name, `${sessionId}.jsonl`);
    if ((await mtimeOf(file)) !== null) return file;
  }
  return null;
}
