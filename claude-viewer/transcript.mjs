// Claude Code's own session transcripts, read straight from disk:
//
//   ~/.claude/projects/<cwd with / and . as ->/<sessionId>.jsonl
//   ~/.claude/projects/<same>/<sessionId>/subagents/agent-<id>.jsonl
//   ~/.claude/projects/<same>/<sessionId>/subagents/agent-<id>.meta.json
//
// Ported from the claude-web extension's server.js (the tailing, subagent
// correlation and session lookup there were verified against a few hundred
// real transcripts), with compaction boundaries passed through so the tab can
// draw them. Every read is best-effort: a missing or half-written file adds
// nothing rather than failing the request.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// Each complete JSON line of a buffer. A partial trailing line (the CLI may be
// mid-append) is skipped here and re-read whole on the next call.
export function parseJsonlBuffer(buf) {
  const entries = [];
  for (const line of buf.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Partial trailing line.
    }
  }
  return entries;
}

// The complete lines appended past `offset`. The returned offset only ever
// advances to just after the last newline read, so a line still being written
// is never consumed early.
export async function tailSince(filePath, offset) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return { entries: [], newOffset: offset };
  }
  try {
    const stat = await handle.stat();
    // A file that shrank was rewritten: start it over.
    const start = stat.size < offset ? 0 : offset;
    if (stat.size <= start) return { entries: [], newOffset: start };
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline === -1) return { entries: [], newOffset: start };
    const complete = buf.subarray(0, lastNewline + 1);
    return { entries: parseJsonlBuffer(complete), newOffset: start + complete.length };
  } finally {
    await handle.close();
  }
}

// Claude Code's project directory naming: every "/" and "." becomes "-" (and
// on Windows the drive colon and backslashes too).
export function projectDirFor(cwd) {
  return path.join(PROJECTS_DIR, cwd.replace(/[\\/:.]/g, "-"));
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// A session's transcript file: the cwd's project dir first (one access), then
// every project dir.
export async function findSessionFile(sessionId, cwd) {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  if (cwd) {
    const direct = path.join(projectDirFor(cwd), `${sessionId}.jsonl`);
    if (await exists(direct)) return direct;
  }
  let dirs;
  try {
    dirs = await fs.readdir(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

// The most recently written transcript in a directory, or null.
export async function freshestSessionFile(dirPath) {
  let names;
  try {
    names = (await fs.readdir(dirPath)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let best = null;
  let bestMtime = -Infinity;
  for (const name of names) {
    const filePath = path.join(dirPath, name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        best = filePath;
      }
    } catch {
      // Vanished mid-scan.
    }
  }
  return best;
}

export function sessionIdOfFile(filePath) {
  return path.basename(filePath, ".jsonl");
}

// agentId -> the Agent/Task tool_use id that spawned it, per session. Built
// from tool results as the main file is tailed; only a fallback for the meta
// file below, which exists from spawn time.
const correlationBySession = new Map();

export function extendCorrelation(sessionId, entries) {
  let map = correlationBySession.get(sessionId);
  if (!map) {
    map = new Map();
    correlationBySession.set(sessionId, map);
  }
  for (const entry of entries) {
    const agentId = entry?.toolUseResult?.agentId;
    if (!agentId) continue;
    const content = entry.message?.content;
    const toolResult = Array.isArray(content) ? content.find((b) => b?.type === "tool_result") : null;
    if (typeof toolResult?.tool_use_id === "string") map.set(agentId, toolResult.tool_use_id);
  }
  return map;
}

// Meta files never change once written, so a successful read is kept for the
// life of the process; a missing one is retried (it can land just after the
// agent's .jsonl).
const agentMetaCache = new Map();

export async function readAgentMetaToolUseId(metaFile) {
  if (agentMetaCache.has(metaFile)) return agentMetaCache.get(metaFile);
  try {
    const meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
    const toolUseId = typeof meta.toolUseId === "string" ? meta.toolUseId : null;
    if (toolUseId) agentMetaCache.set(metaFile, toolUseId);
    return toolUseId;
  } catch {
    return null;
  }
}

// A message the person sent while Claude was already working, as Claude Code
// records it once it picks the message up. Nothing else in the transcript
// carries it: a queued message absorbed into the running turn never becomes a
// "user" entry of its own (the queue-operation pair around it says
// `reason: "absorbed_mid_turn"`), it is folded into the turn as an attachment
// alongside the next tool result — so without this the tab simply never
// showed what you typed mid-run, while the terminal showed it the whole time.
// Verified against every transcript on this machine: 149 of these, not one of
// which also appears as a "user" entry, so reading them costs no duplicates.
// Only the person's own are messages; the same attachment shape also carries
// task notifications and peer messages, which the terminal doesn't present as
// something you said either.
function queuedHumanMessage(entry) {
  const a = entry.attachment;
  if (!a || a.type !== "queued_command") return null;
  if (a.origin?.kind !== "human" || a.isMeta === true) return null;
  const prompt = typeof a.prompt === "string" ? a.prompt : "";
  if (!prompt.trim()) return null;
  return {
    type: "user",
    uuid: String(entry.uuid ?? ""),
    // The attachment is appended when the message is absorbed but stamped
    // when it was typed, which is the time to show.
    timestamp: typeof a.timestamp === "string" ? a.timestamp : typeof entry.timestamp === "string" ? entry.timestamp : null,
    isMeta: false,
    isCompactSummary: false,
    message: { role: "user", content: prompt },
    queued: true,
  };
}

// What the tab renders: user and assistant messages as they are, messages
// queued mid-turn, plus compaction boundaries reduced to what the divider
// shows.
export function toTranscriptMessages(entries) {
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "attachment") {
      const queued = queuedHumanMessage(e);
      if (queued) out.push(queued);
    } else if (e.type === "user" || e.type === "assistant") {
      out.push({
        type: e.type,
        uuid: String(e.uuid ?? ""),
        timestamp: typeof e.timestamp === "string" ? e.timestamp : null,
        isMeta: e.isMeta === true,
        isCompactSummary: e.isCompactSummary === true,
        message: e.message,
        toolUseResult: e.toolUseResult,
      });
    } else if (e.type === "system" && e.subtype === "compact_boundary") {
      const meta = e.compactMetadata ?? {};
      out.push({
        type: "compact_boundary",
        uuid: String(e.uuid ?? ""),
        timestamp: typeof e.timestamp === "string" ? e.timestamp : null,
        trigger: typeof meta.trigger === "string" ? meta.trigger : "auto",
        preTokens: Number.isFinite(meta.preTokens) ? meta.preTokens : null,
        postTokens: Number.isFinite(meta.postTokens) ? meta.postTokens : null,
      });
    }
  }
  return out;
}

// New messages for a session since `cursor` ({ main, agents } byte offsets,
// or null for everything), with each subagent's messages tagged by the tool
// call that spawned it. A subagent that can't be tied to its tool call yet is
// left unread (its offset doesn't advance) so it is picked up once it can.
export async function readTranscript(file, cursor) {
  const sessionId = sessionIdOfFile(file);
  const messages = [];
  const { entries, newOffset } = await tailSince(file, cursor?.main ?? 0);
  messages.push(...toTranscriptMessages(entries));
  const correlation = extendCorrelation(sessionId, entries);

  const subagentsDir = path.join(path.dirname(file), sessionId, "subagents");
  let names = [];
  try {
    names = (await fs.readdir(subagentsDir)).filter((n) => n.startsWith("agent-") && n.endsWith(".jsonl"));
  } catch {
    // No subagents in this session.
  }
  const agents = { ...(cursor?.agents ?? {}) };
  for (const name of names) {
    const agentId = name.slice("agent-".length, -".jsonl".length);
    const parent =
      (await readAgentMetaToolUseId(path.join(subagentsDir, `agent-${agentId}.meta.json`))) ?? correlation.get(agentId);
    if (!parent) continue;
    const tail = await tailSince(path.join(subagentsDir, name), agents[name] ?? 0);
    agents[name] = tail.newOffset;
    for (const m of toTranscriptMessages(tail.entries)) messages.push({ ...m, parent_tool_use_id: parent });
  }
  return { messages, cursor: { main: newOffset, agents } };
}
