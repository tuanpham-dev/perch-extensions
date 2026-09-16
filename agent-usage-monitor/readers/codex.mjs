// Codex's usage, from its rollout files:
//
//   ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl
//
// Every turn appends an event_msg line of type "token_count" carrying the
// session's CUMULATIVE totals so far, so per-block tokens are the deltas
// between consecutive lines. The same line carries Codex's own rate limits
// (used percent, window length, reset time). Sessions that ended before a
// turn completed log `info: null` and contribute nothing.
//
// Codex records no cost, so spend is reported as unsupported rather than
// guessed from a price table.
//
// The rollouts stopped carrying usage at all on this machine (info: null,
// empty rate_limits) once the account ran out of quota, so the limits come
// from the CLI itself where it answers — see codexAppServer.mjs — and the
// files remain the fallback.
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { blocksFor } from "../usageModel.mjs";
import { limitsFromAccount, planType, readAccount, todayTokensFromAccount, windowLabel } from "./codexAppServer.mjs";


const SESSIONS_DIR = path.join(homedir(), ".codex", "sessions");
const BLOCKS_SHOWN = 6;
// Two rollouts in the same folder written this close together can't be told
// apart by folder alone, so the model lookup gives up instead of guessing.
const AMBIGUOUS_WINDOW_MS = 60_000;
// A rollout older than this belongs to a session that has stopped writing;
// the widget describes what is running now, so it reports nothing instead.
const ACTIVE_WINDOW_MS = 30 * 60_000;

export const id = "codex";
export const label = "Codex";
// The registry program core matches windows on.
export const program = "codex";

export async function available() {
  try {
    return (await stat(SESSIONS_DIR)).isDirectory();
  } catch {
    return false;
  }
}

// rollout files are nested <year>/<month>/<day>/, so walk rather than glob.
async function listRollouts() {
  const out = [];
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 3) return walk(full, depth + 1);
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
        try {
          out.push({ file: full, mtime: (await stat(full)).mtimeMs });
        } catch {
          // vanished between listing and stat
        }
      }),
    );
  };
  await walk(SESSIONS_DIR, 0);
  return out;
}

// One rollout's usage entries (deltas), its newest limits, model and cwd.
// Exported for the tests: the pure half, given the file's text.
export function parseRollout(text) {
  const entries = [];
  let previousTotal = 0;
  let limits = null;
  let model = null;
  let cwd = null;
  let lastAt = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // half-written line at the end of a live session
    }
    const payload = obj?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (typeof payload.model === "string") model = payload.model;
    if (typeof payload.cwd === "string") cwd = payload.cwd;
    if (payload.type !== "token_count") continue;
    if (payload.rate_limits) limits = payload.rate_limits;
    const info = payload.info;
    if (!info || typeof info !== "object") continue;
    const total = info.total_token_usage;
    if (!total || typeof total !== "object") continue;
    const timestamp = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isFinite(timestamp)) continue;
    lastAt = timestamp;
    const cumulative = numberOr(total.total_tokens, 0);
    // A fresh session starts from zero; a resumed one can report a total
    // below the previous line only if something reset, so clamp at zero.
    const delta = Math.max(0, cumulative - previousTotal);
    previousTotal = cumulative;
    if (delta === 0) continue;
    const output = numberOr(total.output_tokens, 0);
    const cacheRead = numberOr(total.cached_input_tokens, 0);
    const cacheCreation = numberOr(total.cache_write_input_tokens, 0);
    entries.push({
      timestamp,
      model: model ?? "unknown",
      // Split the delta the way the cumulative totals are split, so the
      // block columns line up with Claude's.
      input: Math.max(0, delta - share(delta, cumulative, output)),
      output: share(delta, cumulative, output),
      cacheRead: share(delta, cumulative, cacheRead),
      cacheCreation: share(delta, cumulative, cacheCreation),
    });
  }
  return { entries, limits, model, cwd, lastAt };
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// This line's share of a cumulative column, rounded — the files carry
// running totals only, so a turn's own split has to be apportioned.
function share(delta, cumulativeTotal, cumulativeColumn) {
  if (cumulativeTotal <= 0) return 0;
  return Math.round((delta * cumulativeColumn) / cumulativeTotal);
}

// The limit rows Codex actually filled in; a null window is simply absent.
export function limitsFrom(rateLimits, now) {
  if (!rateLimits || typeof rateLimits !== "object") return [];
  const out = [];
  for (const key of ["primary", "secondary"]) {
    const entry = rateLimits[key];
    if (!entry || typeof entry !== "object") continue;
    const usedPercent = entry.used_percent;
    if (typeof usedPercent !== "number") continue;
    const resetsAt = typeof entry.resets_at === "number" ? entry.resets_at * 1000 : null;
    if (resetsAt !== null && resetsAt <= now) continue;
    out.push({ label: windowLabel(entry.window_minutes), usedPercent, resetsAt });
  }
  return out;
}

export async function usage({ now, blockMs }) {
  const notes = [];
  const rollouts = (await listRollouts()).sort((a, b) => b.mtime - a.mtime);
  const windowStart = now - BLOCKS_SHOWN * blockMs;
  // The newest rollout is always read, however old it is: its limit block is
  // the only place Codex records the window it is currently in, and a
  // 30-day window outlives the blocks on screen by far.
  const toRead = rollouts.filter((r, i) => i === 0 || r.mtime >= windowStart);
  const entries = [];
  let limits = null;
  let unreadable = 0;

  const parsed = await Promise.all(
    toRead.map(async (rollout) => {
      try {
        return { rollout, parsed: parseRollout(await readFile(rollout.file, "utf8")) };
      } catch {
        unreadable += 1;
        return null;
      }
    }),
  );
  for (const entry of parsed) {
    if (!entry) continue;
    entries.push(...entry.parsed.entries.filter((e) => e.timestamp >= windowStart));
    // Newest first, so the first limit block seen is the current one.
    if (!limits && entry.parsed.limits) limits = entry.parsed.limits;
  }
  if (unreadable > 0) notes.push(`${unreadable} rollout(s) could not be read`);

  const blocks = blocksFor(entries, now, blockMs)
    .sort((a, b) => b.start - a.start)
    .slice(0, BLOCKS_SHOWN);

  // Ask the CLI first: its answer is current, while a rollout's limit block
  // describes whenever that session last ran. Falls back to the files when
  // codex isn't installed, is signed out, or doesn't answer in time.
  const account = await readAccount();
  const fromCli = limitsFromAccount(account, now);
  const limitRows = fromCli.length > 0 ? fromCli : limitsFrom(limits, now);
  const plan = planType(account);
  const todayTokens = todayTokensFromAccount(account, now);
  if (blocks.length === 0 && typeof todayTokens === "number" && todayTokens > 0) {
    // Its own files record nothing, but Codex still counts the day.
    notes.push(`${todayTokens.toLocaleString()} tokens today, by Codex's own count`);
  }

  return {
    blocks,
    limits: limitRows,
    plan,
    // Codex reports no cost anywhere in its files.
    spend: { supported: false },
    notes,
  };
}

// Which rollout this codex process has open. Codex keeps no session index of
// its own, and consecutive sessions in one folder are written seconds apart,
// so the folder alone often can't tell them apart - the open file descriptor
// can. Linux only; elsewhere the folder match below takes over.
async function rolloutOfProcess(pid) {
  if (process.platform !== "linux" || !Number.isFinite(pid)) return null;
  let fds;
  try {
    fds = await readdir(`/proc/${pid}/fd`);
  } catch {
    return null; // another user's process, or it exited
  }
  for (const fd of fds) {
    let target;
    try {
      target = await readlink(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    if (target.startsWith(SESSIONS_DIR) && target.endsWith(".jsonl")) return target;
  }
  return null;
}

// The model this window's codex session is using: from the rollout its own
// process has open, or failing that the most recent rollout in the same
// folder. Two live sessions in one folder written within AMBIGUOUS_WINDOW_MS
// can't be told apart that way, and null is better than naming the wrong
// session's model.
export async function modelFor({ pid, cwd, now = Date.now() }) {
  const open = await rolloutOfProcess(pid);
  if (open) {
    try {
      return parseRollout(await readFile(open, "utf8")).model ?? null;
    } catch {
      return null;
    }
  }
  if (!cwd) return null;
  const rollouts = (await listRollouts())
    .filter((r) => now - r.mtime <= ACTIVE_WINDOW_MS)
    .sort((a, b) => b.mtime - a.mtime);
  const matches = [];
  for (const rollout of rollouts.slice(0, 20)) {
    let text;
    try {
      text = await readFile(rollout.file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseRollout(text);
    if (!parsed.cwd || !sameFolder(parsed.cwd, cwd)) continue;
    matches.push({ ...parsed, mtime: rollout.mtime });
    if (matches.length === 2) break;
  }
  if (matches.length === 0) return null;
  if (matches.length > 1 && Math.abs(matches[0].mtime - matches[1].mtime) < AMBIGUOUS_WINDOW_MS) {
    return null;
  }
  return matches[0].model ?? null;
}

// The app hands out ~-shortened paths; the rollouts carry absolute ones.
function sameFolder(a, b) {
  return expand(a) === expand(b);
}

function expand(p) {
  return p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p;
}
