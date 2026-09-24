import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentReport,
  agentStats,
  agentStatus,
  applyAgentMeta,
  applyMessages,
  createChatModel,
  listAgents,
  type TranscriptMessage,
} from "./chatModel.ts";

const userMessage = (text: string) => ({ type: "user" as const, uuid: "u1", message: { role: "user", content: text } });

test("a pasted_content block shows as the text the person wrote", () => {
  const model = createChatModel();
  applyMessages(model, [userMessage('\n\n<pasted_content id="4a5c">\nadd filters to the ticket list\n</pasted_content id="4a5c">\n')]);
  assert.deepEqual(
    model.items.map((i) => (i.kind === "text" ? i.text : i.kind)),
    ["add filters to the ticket list"],
  );
});

test("text around a pasted_content block is kept", () => {
  const model = createChatModel();
  applyMessages(model, [userMessage('look at this:\n\n<pasted_content id="00ff">\nstack trace\n</pasted_content id="00ff">\n\nwhat broke?')]);
  const item = model.items[0];
  assert.equal(item?.kind, "text");
  assert.equal(item.kind === "text" ? item.text : "", "look at this:\n\nstack trace\n\nwhat broke?");
});

// ---- Subagents ----

const T0 = Date.parse("2026-09-23T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const agentCall = (id: string, parent: string | null = null): TranscriptMessage => ({
  type: "assistant",
  timestamp: at(0),
  parent_tool_use_id: parent,
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "Agent", input: { description: "Find hook callers", subagent_type: "Explore", prompt: "Find every caller." } }],
  },
});
const launched = (id: string, parent: string | null = null): TranscriptMessage => ({
  type: "user",
  timestamp: at(1),
  parent_tool_use_id: parent,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "Async agent launched successfully. agentId: a1" }] }] },
  toolUseResult: { status: "async_launched", agentId: "a1", isAsync: true },
});
const finishedInline = (id: string, isError = false): TranscriptMessage => ({
  type: "user",
  timestamp: at(30),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text: "Found three callers." }] }] },
});
const step = (parent: string, s: number, toolId: string, usage = 1000): TranscriptMessage => ({
  type: "assistant",
  timestamp: at(s),
  parent_tool_use_id: parent,
  message: {
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "tool_use", id: toolId, name: "Grep", input: { pattern: "reportAgentHook" } }],
    usage: { input_tokens: usage, cache_read_input_tokens: 500, output_tokens: 20 },
  },
});
const notify = (id: string, status: string, s: number, extra: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
  type: "task_notification",
  timestamp: at(s),
  toolUseId: id,
  status,
  result: "Three callers pass a pane id.",
  tokens: 4200,
  toolUses: 7,
  durationMs: 61000,
  ...extra,
});

test("a foreground agent is running until its call returns, then done or failed", () => {
  const model = createChatModel();
  applyMessages(model, [agentCall("t1"), step("t1", 5, "g1")]);
  assert.equal(agentStatus(model.tools.t1), "running");
  applyMessages(model, [finishedInline("t1")]);
  assert.equal(agentStatus(model.tools.t1), "done");
  assert.equal(agentReport(model.tools.t1), "Found three callers.");

  const failed = createChatModel();
  applyMessages(failed, [agentCall("t1"), finishedInline("t1", true)]);
  assert.equal(agentStatus(failed.tools.t1), "failed");
});

test("a background agent runs until its notification, whatever the launch said", () => {
  const model = createChatModel();
  applyMessages(model, [agentCall("t1"), launched("t1"), step("t1", 5, "g1")]);
  assert.equal(agentStatus(model.tools.t1), "running");
  // The launch result is metadata, never the report.
  assert.equal(agentReport(model.tools.t1), null);
  applyMessages(model, [notify("t1", "completed", 70)]);
  assert.equal(agentStatus(model.tools.t1), "done");
  assert.equal(agentReport(model.tools.t1), "Three callers pass a pane id.");

  for (const [status, expected] of [["failed", "failed"], ["stopped", "stopped"], ["killed", "stopped"]] as const) {
    const m = createChatModel();
    applyMessages(m, [agentCall("t1"), launched("t1"), notify("t1", status, 70)]);
    assert.equal(agentStatus(m.tools.t1), expected, status);
  }
});

test("an agent that writes after its notification was resumed and runs again", () => {
  const model = createChatModel();
  applyMessages(model, [agentCall("t1"), launched("t1"), step("t1", 5, "g1"), notify("t1", "completed", 70)]);
  applyMessages(model, [step("t1", 90, "g2")]);
  assert.equal(agentStatus(model.tools.t1), "running");
  applyMessages(model, [notify("t1", "completed", 120)]);
  assert.equal(agentStatus(model.tools.t1), "done");
});

test("stats count the transcript while running and take Claude Code's totals once done", () => {
  const model = createChatModel();
  applyMessages(model, [agentCall("t1"), launched("t1"), step("t1", 5, "g1", 1000), step("t1", 20, "g2", 3000)]);
  const running = agentStats(model.tools.t1, T0 + 45_000);
  assert.deepEqual(running, { elapsedMs: 40_000, steps: 2, tokens: 3520, model: "claude-haiku-4-5-20251001" });
  applyMessages(model, [notify("t1", "completed", 70)]);
  assert.deepEqual(agentStats(model.tools.t1, T0 + 999_000), { elapsedMs: 61000, steps: 7, tokens: 4200, model: "claude-haiku-4-5-20251001" });
});

test("the list holds every subagent in start order, nested ones one level deeper", () => {
  const model = createChatModel();
  applyMessages(model, [
    agentCall("t1"),
    launched("t1"),
    step("t1", 5, "g1"),
    agentCall("t2", "t1"),
    step("t2", 8, "g2"),
    agentCall("t3"),
  ]);
  applyAgentMeta(model, [
    { toolUseId: "t1", agentId: "a1", agentType: "general-purpose", description: "Map the hook pipeline" },
    { toolUseId: "t3", agentId: "a3", agentType: "Explore", description: null },
  ]);
  assert.deepEqual(listAgents(model), [
    { toolId: "t1", depth: 0 },
    { toolId: "t2", depth: 1 },
    { toolId: "t3", depth: 0 },
  ]);
  assert.equal(model.tools.t1.agent?.type, "general-purpose");
  assert.equal(model.tools.t1.agent?.description, "Map the hook pipeline");
  // A description the meta leaves out keeps the one from the call.
  assert.equal(model.tools.t3.agent?.description, "Find hook callers");
});

test("a finish notification is one line where it arrived, and only for an agent", () => {
  const model = createChatModel();
  applyMessages(model, [agentCall("t1"), launched("t1"), userMessage("next thing"), notify("t1", "completed", 70), notify("toolu_shell", "stopped", 71)]);
  assert.deepEqual(
    model.items.map((i) => i.kind),
    ["tool", "text", "agentNote"],
  );
  const nested = createChatModel();
  applyMessages(nested, [agentCall("t1"), agentCall("t2", "t1"), launched("t2", "t1"), { ...notify("t2", "completed", 70), parent_tool_use_id: "t1" }]);
  assert.deepEqual(
    nested.tools.t1.children.map((i) => i.kind),
    ["tool", "agentNote"],
  );
});
