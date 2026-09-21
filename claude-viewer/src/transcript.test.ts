// Transcript entries against the shapes Claude Code actually writes. The
// queued-message fixtures below are copied from a real session
// (Claude Code 2.1.278), where a message sent mid-run is recorded as a
// "queued_command" attachment and never as a "user" entry of its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { toTranscriptMessages } from "../transcript.mjs";

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
  assert.deepEqual(toTranscriptMessages(entries), []);
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
