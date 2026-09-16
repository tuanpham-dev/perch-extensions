// Claude Code's own cached view of the account's limits.
//
// The CLI keeps the account API's answer in ~/.claude.json under
// cachedUsageUtilization and refreshes it as it runs. That cache carries
// what no other local file does: the per-model weekly cap - a "weekly_scoped"
// limit naming the model - alongside the session and all-model weeks, each
// with a real reset timestamp. Reading it costs one file read: no CLI to
// drive in a pty, no folder that has to be trusted first, and no credential
// anywhere near this code.
//
// The same file's `projects` map is what says which folders the user has
// trusted, so this is the config the trust question was really about.
//
// Verified against Claude Code 2.x on 2026-09-15, whose cache reads:
//   fetchedAtMs: 1789525988561
//   utilization.limits: [
//     { kind: "session",       percent: 47, resets_at: "2026-09-16T03:30:00Z" },
//     { kind: "weekly_all",    percent: 38, resets_at: "2026-09-20T16:00:00Z" },
//     { kind: "weekly_scoped", percent: 32, resets_at: "2026-09-20T16:00:00Z",
//       scope: { model: { display_name: "Fable" } } } ]
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CONFIG = path.join(homedir(), ".claude.json");

// The cache only moves while the CLI runs, so an old one describes an old
// week. Past a session window's length the numbers have had time to be wrong
// by a lot, and saying nothing beats showing a percentage that isn't true.
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

// ~/.claude.json is large (~170 KB here) and this is polled, so it is parsed
// once per change rather than once per request.
let cache = null; // { mtimeMs, size, doc }

async function readConfig() {
  let info;
  try {
    info = await stat(CONFIG);
  } catch {
    return null;
  }
  if (cache && cache.mtimeMs === info.mtimeMs && cache.size === info.size) return cache.doc;
  let doc;
  try {
    doc = JSON.parse(await readFile(CONFIG, "utf8"));
  } catch {
    return null; // mid-write, or a config this doesn't understand
  }
  cache = { mtimeMs: info.mtimeMs, size: info.size, doc };
  return doc;
}

// Exported for the tests: the cached block in, the windows the UI draws out.
// A window whose reset has passed describes a window that no longer exists,
// and one the CLI hasn't refreshed in hours describes a week that has moved
// on; both are dropped rather than shown stale.
export function windowsFrom(cached, now) {
  const fetchedAt = cached?.fetchedAtMs;
  if (typeof fetchedAt !== "number" || now - fetchedAt > MAX_AGE_MS) return [];
  const limits = cached?.utilization?.limits;
  if (!Array.isArray(limits)) return [];
  const out = [];
  for (const limit of limits) {
    const label = labelFor(limit);
    if (!label || typeof limit.percent !== "number") continue;
    const resetsAt = epochOf(limit.resets_at);
    if (resetsAt !== null && resetsAt <= now) continue;
    if (out.some((w) => w.label === label)) continue;
    // A model's week is a slice of the account's week, not a window of its
    // own, and it resets with it: the bar names the model instead of
    // repeating the week's countdown.
    const scope = limit.kind === "weekly_scoped" ? limit?.scope?.model?.display_name : null;
    out.push({ label, usedPercent: limit.percent, resetsAt, scoped: Boolean(scope), scope: scope ?? null });
  }
  return out;
}

// The labels the rest of the extension already uses for these windows, so a
// cached one and a statusline one are the same row rather than two.
function labelFor(limit) {
  if (limit?.kind === "session") return "5-hour";
  if (limit?.kind === "weekly_all") return "weekly";
  if (limit?.kind !== "weekly_scoped") return null;
  const model = limit?.scope?.model?.display_name;
  return typeof model === "string" && model ? `${model} weekly` : null;
}

function epochOf(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// The account's limit windows as Claude Code last saw them, or an empty array
// when the config isn't there, has no cache yet, or has gone stale. Never
// throws: this is an extra on top of what the statusline file records.
export async function readWindows(now) {
  const doc = await readConfig();
  return windowsFrom(doc?.cachedUsageUtilization, now);
}
