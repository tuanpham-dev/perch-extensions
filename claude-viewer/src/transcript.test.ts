// Transcript entries against the shapes Claude Code actually writes. The
// queued-message fixtures below are copied from a real session
// (Claude Code 2.1.278), where a message sent mid-run is recorded as a
// "queued_command" attachment and never as a "user" entry of its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chunkStartIndex, readTranscriptBefore, readTranscriptTail, taskNotificationOf, toTranscriptMessages } from "../transcript.mjs";
import { addLine } from "../usageTotals.mjs";

const queuedAttachment = (over: Record<string, unknown> = {}) => ({
  type: "attachment",
  uuid: "att-1",
  timestamp: "2026-09-21T14:24:20.000Z",
  attachment: {
    type: "queued_command",
    prompt: "check the other file too",
    commandMode: "prompt",
    origin: { kind: "human" },
    timestamp: "2026-09-21T14:24:14.885Z",
    ...over,
  },
});

test("a message queued mid-turn reads as a user message", () => {
  const [message, ...rest] = toTranscriptMessages([queuedAttachment()]);
  assert.equal(rest.length, 0);
  assert.equal(message.type, "user");
  assert.equal(message.queued, true);
  assert.equal(message.isMeta, false);
  assert.deepEqual(message.message, { role: "user", content: "check the other file too" });
});

test("it is timestamped when it was typed, not when it was absorbed", () => {
  assert.equal(toTranscriptMessages([queuedAttachment()])[0].timestamp, "2026-09-21T14:24:14.885Z");
});

test("task notifications and peer messages are not the person talking", () => {
  const entries = [
    queuedAttachment({ origin: undefined, commandMode: "task-notification", prompt: "<task-notification>…</task-notification>" }),
    queuedAttachment({ origin: { kind: "task-notification" } }),
    queuedAttachment({ origin: { kind: "peer" }, isMeta: true }),
    queuedAttachment({ prompt: "   " }),
  ];
  const out = toTranscriptMessages(entries);
  // None of them is something the person said; the first is a notification
  // of its own (see the task-notification tests below).
  assert.deepEqual(out.filter((m) => m.type === "user"), []);
  assert.deepEqual(
    out.map((m) => m.type),
    ["task_notification"],
  );
});

test("other attachments stay out of the conversation", () => {
  assert.deepEqual(toTranscriptMessages([{ type: "attachment", uuid: "a", attachment: { type: "file", path: "x.ts" } }]), []);
});

test("user and assistant entries still come through unchanged", () => {
  const entries = [
    { type: "user", uuid: "u1", timestamp: "2026-09-21T14:00:00.000Z", message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: "a1", timestamp: "2026-09-21T14:00:01.000Z", message: { role: "assistant", content: [] } },
    { type: "system", subtype: "compact_boundary", uuid: "c1", compactMetadata: { trigger: "manual", preTokens: 100, postTokens: 10 } },
  ];
  assert.deepEqual(
    toTranscriptMessages(entries).map((m) => m.type),
    ["user", "assistant", "compact_boundary"],
  );
  assert.equal(toTranscriptMessages(entries)[0].queued, undefined);
});

// Task notifications, from real entries (Claude Code 2.1.281). An agent's
// finish carries its report and usage; other tasks (a background shell
// command, an artifact watch) use the same envelope with fewer fields.
const agentFinish = [
  "<task-notification>",
  "<task-id>a78b91170f32ab45f</task-id>",
  "<tool-use-id>toolu_01BdFaTPyprRGWPzYurCCnL5</tool-use-id>",
  "<output-file>/tmp/claude-1002/x/tasks/a78b91170f32ab45f.output</output-file>",
  "<status>completed</status>",
  '<summary>Agent "Review the batch UI code" finished</summary>',
  "<note>A task-notification fires each time this agent stops with no live background children of its own.</note>",
  "<result>Reviewed all nine files.",
  "",
  "A quoted <status>failed</status> and a stray </result> inside the report.</result>",
  "<usage><subagent_tokens>120010</subagent_tokens><tool_uses>29</tool_uses><duration_ms>306158</duration_ms></usage>",
  "</task-notification>",
].join("\n");

const notificationUser = (content: string) => ({
  type: "user",
  uuid: "c7a431cf-5932-409c-b66c-35f6b47b7ab5",
  timestamp: "2026-09-17T03:38:40.220Z",
  origin: { kind: "task-notification" },
  message: { role: "user", content },
});

test("an agent's finish notification is read, report and usage included", () => {
  const n = taskNotificationOf(notificationUser(agentFinish));
  assert.equal(n?.type, "task_notification");
  assert.equal(n?.toolUseId, "toolu_01BdFaTPyprRGWPzYurCCnL5");
  // The status is the envelope's, not the one the report quotes.
  assert.equal(n?.status, "completed");
  assert.equal(n?.summary, 'Agent "Review the batch UI code" finished');
  assert.equal(n?.result, "Reviewed all nine files.\n\nA quoted <status>failed</status> and a stray </result> inside the report.");
  assert.equal(n?.tokens, 120010);
  assert.equal(n?.toolUses, 29);
  assert.equal(n?.durationMs, 306158);
  assert.equal(n?.timestamp, "2026-09-17T03:38:40.220Z");
});

test("a notification is never a message the person sent", () => {
  const shell = notificationUser(
    "<task-notification>\n<task-id>bbuz3s2oq</task-id>\n<tool-use-id>toolu_014Z486PcmU9dJBL7ocCdbDT</tool-use-id>\n<status>stopped</status>\n<summary>Background shell command didn't finish before the previous session ended</summary>\n</task-notification>",
  );
  const out = toTranscriptMessages([shell, notificationUser(agentFinish)]);
  assert.deepEqual(
    out.map((m) => m.type),
    ["task_notification", "task_notification"],
  );
  assert.equal(out[0].result, null);
  assert.equal(out[0].tokens, null);
});

test("a notification folded into a running turn is read from its attachment", () => {
  const folded = {
    type: "attachment",
    uuid: "7ef971b5-f02b-44c7-bdbd-e70a9e511e25",
    timestamp: "2026-09-17T04:08:00.759Z",
    attachment: {
      type: "queued_command",
      prompt: agentFinish,
      commandMode: "task-notification",
      origin: { kind: "task-notification" },
      timestamp: "2026-09-17T04:08:00.759Z",
    },
  };
  const out = toTranscriptMessages([folded]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "task_notification");
  assert.equal(out[0].toolUseId, "toolu_01BdFaTPyprRGWPzYurCCnL5");
});

test("a message the person typed is still a message", () => {
  assert.equal(taskNotificationOf(notificationUser("what does <task-notification> mean?")), null);
  const out = toTranscriptMessages([queuedAttachment()]);
  assert.equal(out[0].type, "user");
  assert.equal(out[0].queued, true);
});

test("a nested agent's finish, recorded in its parent's transcript without an origin, is read", () => {
  // Claude Code 2.1.281, subagents/agent-<parent>.jsonl: the attachment
  // carries commandMode but no origin.
  const inParent = {
    type: "attachment",
    uuid: "n-1",
    timestamp: "2026-09-23T14:40:12.000Z",
    attachment: { type: "queued_command", prompt: agentFinish, commandMode: "task-notification" },
  };
  const out = toTranscriptMessages([inParent]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "task_notification");
  // The person's own queued message that happens to quote the tag stays theirs.
  const typed = { ...inParent, attachment: { type: "queued_command", prompt: agentFinish, origin: { kind: "human" } } };
  assert.equal(toTranscriptMessages([typed])[0].type, "user");
});

test("a report reads as the agent wrote it, not XML-escaped", () => {
  // Real: the agent's transcript said Promise<ReportOutcome>, the
  // notification carrying the same report said Promise&lt;ReportOutcome&gt;.
  const escaped = agentFinish.replace(
    "Reviewed all nine files.",
    "Line 257: `export async function reportAgentHook(): Promise&lt;ReportOutcome&gt; {` &amp; more",
  );
  const n = taskNotificationOf(notificationUser(escaped));
  assert.ok(n?.result?.startsWith("Line 257: `export async function reportAgentHook(): Promise<ReportOutcome> {` & more"));
});

// ---- Chunked reading ----

const use = (id: string, uuid: string) => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: {} }] } });
const result = (id: string, uuid: string) => ({ type: "user", uuid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const said = (text: string, uuid: string) => ({ type: "user", uuid, message: { role: "user", content: text } });

test("a chunk never starts between a tool call and its result", () => {
  const lines = [said("go", "u1"), use("t1", "a1"), result("t1", "r1"), use("t2", "a2"), result("t2", "r2")].map((entry, i) => ({ offset: i, entry }));
  // From line 0 everything is answered within the chunk; the earliest start wins.
  assert.equal(chunkStartIndex(lines), 0);
  // Without the first two lines, t1's result would lose its call.
  assert.equal(chunkStartIndex(lines.slice(2)), 1);
  assert.equal(chunkStartIndex(lines.slice(2, 3)), -1);
});

test("tail and earlier chunks together read the whole transcript once, in order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cv-chunks-"));
  const file = path.join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
  const entries = [];
  for (let i = 0; i < 60; i++) {
    entries.push(said(`prompt ${i} ${"x".repeat(200)}`, `u${i}`), use(`t${i}`, `a${i}`), result(`t${i}`, `r${i}`));
  }
  await writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  try {
    const tail = await readTranscriptTail(file, 2000);
    assert.ok(tail.before !== null, "a long file opens on a tail");
    let all = tail.messages;
    let before = tail.before;
    let cursor = tail.cursor;
    while (before !== null) {
      const r = await readTranscriptBefore(file, before, cursor, 2000);
      all = [...r.messages, ...all];
      before = r.before;
      cursor = r.cursor;
    }
    assert.deepEqual(all.map((m) => m.uuid), entries.map((e) => e.uuid));
    const resultIds = new Set(all.flatMap((m) => (Array.isArray(m.message?.content) ? m.message.content : []).filter((b: { type: string }) => b.type === "tool_result").map((b: { tool_use_id: string }) => b.tool_use_id)));
    assert.equal(resultIds.size, 60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("usage totals count each assistant message once per model", () => {
  const state = { seen: new Set(), byModel: {} as Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number; messages: number }> };
  const line = (id: string, model: string) =>
    JSON.stringify({ type: "assistant", message: { id, model, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, content: [] } });
  addLine(state, line("m1", "claude-opus-5-5"));
  addLine(state, line("m1", "claude-opus-5-5")); // a second content block of the same message
  addLine(state, line("m2", "claude-sonnet-5"));
  addLine(state, line("m3", "<synthetic>"));
  assert.deepEqual(state.byModel["claude-opus-5-5"], { input: 10, output: 5, cacheWrite: 0, cacheRead: 100, messages: 1 });
  assert.equal(state.byModel["claude-sonnet-5"]?.messages, 1);
  assert.equal(Object.keys(state.byModel).length, 2);
});
