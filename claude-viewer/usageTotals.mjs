// A session's token usage over its whole transcript and every subagent's,
// summed per model. A tab only holds the conversation's last chunks, so its
// cost comes from here; pricing stays in the client (src/usage.ts), which
// prices each model's sums: cost is linear in tokens, so that is exact.
//
// Claude Code writes one line per content block of an assistant message, each
// carrying the same message id and usage, so a message counts once per id.
// Files are scanned incrementally: the first read of a large transcript takes
// a moment and runs in the background, and later reads only see new lines.

import fs from "node:fs/promises";
import path from "node:path";
import { sessionIdOfFile } from "./transcript.mjs";

const READ_BYTES = 4 * 1024 * 1024;

// file -> { offsets: Map<path, number>, seen: Set<id>, byModel, running, ready }
const states = new Map();

function emptyState() {
  return { offsets: new Map(), seen: new Set(), byModel: {}, running: null, ready: false };
}

// Adds one transcript line's usage, if it is an assistant message not counted
// yet. Exported for tests.
export function addLine(state, text) {
  // Cheap filter: most lines (tool results, user text) carry no usage.
  if (!text.includes('"usage"') || !text.includes('"assistant"')) return;
  let entry;
  try {
    entry = JSON.parse(text);
  } catch {
    return;
  }
  const m = entry?.type === "assistant" ? entry.message : null;
  if (!m?.usage || typeof m.id !== "string" || !m.model || m.model === "<synthetic>") return;
  if (state.seen.has(m.id)) return;
  state.seen.add(m.id);
  const sums = (state.byModel[m.model] ??= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 });
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  sums.input += n(m.usage.input_tokens);
  sums.output += n(m.usage.output_tokens);
  sums.cacheWrite += n(m.usage.cache_creation_input_tokens);
  sums.cacheRead += n(m.usage.cache_read_input_tokens);
  sums.messages += 1;
}

// Reads one file on from its last offset, whole lines only.
async function scanFile(state, filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return;
  }
  try {
    const { size } = await handle.stat();
    let at = state.offsets.get(filePath) ?? 0;
    if (size < at) at = 0; // rewritten; its messages are already counted by id
    let carry = Buffer.alloc(0);
    const buf = Buffer.alloc(READ_BYTES);
    while (at + carry.length < size) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(READ_BYTES, size - at - carry.length), at + carry.length);
      if (bytesRead === 0) break;
      const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const lastNewline = data.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        carry = Buffer.from(data);
        continue;
      }
      for (const line of data.toString("utf8", 0, lastNewline).split("\n")) addLine(state, line);
      at += lastNewline + 1;
      carry = Buffer.from(data.subarray(lastNewline + 1));
    }
    state.offsets.set(filePath, at);
  } finally {
    await handle.close();
  }
}

async function scanSession(state, file) {
  await scanFile(state, file);
  const dir = path.join(path.dirname(file), sessionIdOfFile(file), "subagents");
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.startsWith("agent-") && n.endsWith(".jsonl"));
  } catch {
    // No subagents in this session.
  }
  for (const name of names) await scanFile(state, path.join(dir, name));
  state.ready = true;
}

/**
 * The session's usage per model as of the last finished scan, or null before
 * the first one finishes. Starts a scan for anything new when none is running,
 * so the figure catches up by the next call without ever delaying this one.
 */
export function usageFor(file) {
  let state = states.get(file);
  if (!state) {
    state = emptyState();
    states.set(file, state);
  }
  if (!state.running) {
    const s = state;
    s.running = scanSession(s, file)
      .catch(() => {})
      .finally(() => {
        s.running = null;
      });
  }
  if (!state.ready) return null;
  return structuredClone(state.byModel);
}

/** Waits for the scan in progress, if any (for tests). */
export async function settled(file) {
  await states.get(file)?.running;
}
