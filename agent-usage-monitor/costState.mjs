// What a Claude Code session cost, from the agent's own books.
//
// Every transcript ends with a {"type":"cost-state"} line carrying the
// session's rolled-up totals: totalCostUSD, per-model token counts and their
// own costUSD. That line is the only real money figure available locally —
// pricing tokens ourselves would be a guess that goes stale — so spend is
// read from it and from nothing else.
//
// Reading it is deliberately cheap: transcripts run to hundreds of MB in
// total, and the line sits at the end, so only the tail of each file is read
// (0.33s across 164 files here, against parsing everything).
import { open, stat } from "node:fs/promises";

// Enough for the cost-state line plus the long assistant lines that can
// follow it; a session that somehow buries it deeper simply reports no cost.
export const TAIL_BYTES = 200 * 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

// The last `bytes` of a file as text, or null when it can't be read. The
// tail is how both the cost line and the current model are found: the data
// that matters is at the end, and a transcript can be hundreds of MB.
export async function readTail(filePath, bytes = TAIL_BYTES) {
  let size;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return null;
  }
  if (size === 0) return null;
  let handle;
  try {
    handle = await open(filePath, "r");
    const start = Math.max(0, size - bytes);
    const { buffer } = await handle.read({ buffer: Buffer.alloc(size - start), position: start });
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// The cost-state record of one transcript, or null when it has none (an
// older session, or one still running its first turn).
export async function readCostState(filePath) {
  const text = await readTail(filePath);
  return text === null ? null : parseCostState(text);
}

// Exported for the tests: the pure half of readCostState. Scans backwards,
// since the line it wants is at the end and a tail read may have cut the
// first line in half.
export function parseCostState(tailText) {
  const lines = tailText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.includes('"cost-state"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // truncated by the tail cut, or half-written
    }
    if (!obj || obj.type !== "cost-state") continue;
    const cost = typeof obj.totalCostUSD === "number" ? obj.totalCostUSD : null;
    if (cost === null) continue;
    const startTime = typeof obj.startTime === "number" ? obj.startTime : Date.parse(obj.startTime);
    return {
      sessionId: typeof obj.sessionId === "string" ? obj.sessionId : null,
      startTime: Number.isFinite(startTime) ? startTime : null,
      totalCostUSD: cost,
      modelUsage: obj.modelUsage && typeof obj.modelUsage === "object" ? obj.modelUsage : {},
      hasUnknownModelCost: obj.hasUnknownModelCost === true,
    };
  }
  return null;
}

// Spend for the two windows the UI shows. Cost is recorded per session, not
// per message, so a session is counted whole, on the day it was last active
// (`at`, the transcript's mtime; `startTime` is the fallback). Dating by the
// start instead would park a session that ran for days on the day it opened
// and leave today at zero.
// `partial` marks that at least one counted session priced a model it didn't
// know, so the total is a floor rather than an exact figure.
export function spendFrom(records, now, startOfDay = defaultStartOfDay) {
  const dayStart = startOfDay(now);
  const weekStart = now - 7 * DAY_MS;
  let today = 0;
  let last7Days = 0;
  let partial = false;
  let counted = 0;
  for (const record of records) {
    if (!record || typeof record.totalCostUSD !== "number") continue;
    const at = Number.isFinite(record.at) ? record.at : record.startTime;
    if (!Number.isFinite(at) || at > now) continue;
    if (at >= weekStart) {
      last7Days += record.totalCostUSD;
      counted += 1;
      if (record.hasUnknownModelCost) partial = true;
    }
    if (at >= dayStart) today += record.totalCostUSD;
  }
  return { supported: true, today, last7Days, partial, sessions: counted };
}

function defaultStartOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
