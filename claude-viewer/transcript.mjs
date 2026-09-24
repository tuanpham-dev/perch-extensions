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

// Meta files never change once written, so a read that names the tool call
// is kept for the life of the process; a missing one is retried (it can land
// just after the agent's .jsonl).
const agentMetaCache = new Map();

// { toolUseId, agentType, description }, each null when absent.
export async function readAgentMeta(metaFile) {
  if (agentMetaCache.has(metaFile)) return agentMetaCache.get(metaFile);
  try {
    const meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
    const read = {
      toolUseId: typeof meta.toolUseId === "string" ? meta.toolUseId : null,
      agentType: typeof meta.agentType === "string" ? meta.agentType : null,
      description: typeof meta.description === "string" ? meta.description : null,
    };
    if (read.toolUseId) agentMetaCache.set(metaFile, read);
    return read;
  } catch {
    return { toolUseId: null, agentType: null, description: null };
  }
}

// A background agent's finish, as Claude Code tells the main agent about it:
//
//   <task-notification>
//   <task-id>…</task-id>
//   <tool-use-id>toolu_…</tool-use-id>     the Agent call that started it
//   <status>completed</status>              seen: completed, failed, stopped
//   <summary>Agent "…" finished</summary>
//   <result>the agent's report</result>
//   <usage><subagent_tokens>…</subagent_tokens><tool_uses>…</tool_uses><duration_ms>…</duration_ms></usage>
//   </task-notification>
//
// It arrives as a "user" entry (origin kind "task-notification") between
// turns, or folded into a running turn as a queued_command attachment. Either
// way it is not something the person said, so it becomes a message of its
// own rather than a user bubble of raw XML. Null for anything else.
const NOTIFICATION_RE = /^\s*<task-notification>/;

function notificationText(entry) {
  if (entry.type === "user") {
    const content = entry.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content) && content.length === 1 && content[0]?.type === "text"
          ? String(content[0].text ?? "")
          : null;
    // Recognized by its content: origin.kind says "task-notification" on
    // 2.1.281, but older entries carry no origin at all.
    return text !== null && NOTIFICATION_RE.test(text) ? text : null;
  }
  // In the main transcript the attachment says origin kind
  // "task-notification"; in a subagent's own transcript (the finish of an
  // agent it started) there is no origin, only commandMode. So it is
  // recognized by content too, and only a message marked as the person's
  // own is ever left alone.
  const a = entry.attachment;
  if (entry.type === "attachment" && a?.type === "queued_command" && a.origin?.kind !== "human") {
    return typeof a.prompt === "string" && NOTIFICATION_RE.test(a.prompt) ? a.prompt : null;
  }
  return null;
}

// The report and summary arrive XML-escaped ("Promise&lt;T&gt;"), while
// the agent's own transcript has the text as written.
function unescapeXml(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function tag(text, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1].trim() : null;
}

function count(text, name) {
  const value = tag(text, name);
  const n = value === null ? NaN : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function taskNotificationOf(entry) {
  if (!entry || typeof entry !== "object") return null;
  const text = notificationText(entry);
  if (text === null) return null;
  // A report can itself mention the tag, so it runs to the LAST close.
  const open = text.indexOf("<result>");
  const close = text.lastIndexOf("</result>");
  const result = open !== -1 && close > open ? unescapeXml(text.slice(open + "<result>".length, close).trim()) : null;
  // Read the other fields outside the report, so a report quoting them can't
  // stand in for the real ones.
  const outside = open !== -1 && close > open ? text.slice(0, open) + text.slice(close) : text;
  const summary = tag(outside, "summary");
  return {
    type: "task_notification",
    uuid: String(entry.uuid ?? ""),
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
    toolUseId: tag(outside, "tool-use-id"),
    status: tag(outside, "status"),
    summary: summary === null ? null : unescapeXml(summary),
    result,
    tokens: count(outside, "subagent_tokens"),
    toolUses: count(outside, "tool_uses"),
    durationMs: count(outside, "duration_ms"),
  };
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
    const notification = taskNotificationOf(e);
    if (notification) {
      out.push(notification);
      continue;
    }
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
  // Every linked subagent's type and description, on every call: the tab
  // may have started from a cursor and never seen an agent's first read.
  const agentMeta = [];
  for (const name of names) {
    const agentId = name.slice("agent-".length, -".jsonl".length);
    const meta = await readAgentMeta(path.join(subagentsDir, `agent-${agentId}.meta.json`));
    const parent = meta.toolUseId ?? correlation.get(agentId);
    if (!parent) continue;
    agentMeta.push({ toolUseId: parent, agentId, agentType: meta.agentType, description: meta.description });
    const tail = await tailSince(path.join(subagentsDir, name), agents[name] ?? 0);
    agents[name] = tail.newOffset;
    for (const m of toTranscriptMessages(tail.entries)) messages.push({ ...m, parent_tool_use_id: parent });
  }
  return { messages, agents: agentMeta, cursor: { main: newOffset, agents } };
}
