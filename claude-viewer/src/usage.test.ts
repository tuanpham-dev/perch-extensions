import assert from "node:assert/strict";
import { test } from "node:test";
import { addToTally, contextWindowFor, costOf, createTally, currentModelLabel, modelFromCommandOutput, modelLabel } from "./usage.ts";

const usage = { input_tokens: 2, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 100_000, output_tokens: 500 };

test("cost of one Opus 5 message by hand", () => {
  // 2*5 + 1000*6.25 + 100000*0.5 + 500*25 = 10 + 6250 + 50000 + 12500 = 68760 per million
  assert.equal(costOf("claude-opus-5", usage), 68_760 / 1_000_000);
});

test("Fable 5.1 uses its own cache read rate", () => {
  // 2*10 + 1000*12.5 + 100000*0.25 + 500*50 = 20 + 12500 + 25000 + 25000
  assert.equal(costOf("claude-fable-5-1", usage), 62_520 / 1_000_000);
});

test("unknown models are not priced", () => {
  assert.equal(costOf("gpt-9", usage), null);
});

test("context windows", () => {
  assert.equal(contextWindowFor("claude-haiku-4-5-20251001"), 200_000);
  assert.equal(contextWindowFor("claude-opus-5"), 1_000_000);
  assert.equal(contextWindowFor("claude-sonnet-4-6[1m]"), 1_000_000);
});

test("a message split across transcript lines counts once", () => {
  const tally = createTally();
  const line = { type: "assistant", message: { id: "msg_1", model: "claude-opus-5", usage } };
  addToTally(tally, [line, line, line]);
  assert.equal(tally.cost, 68_760 / 1_000_000);
  assert.equal(tally.context, 101_002);
  assert.equal(tally.model, "claude-opus-5");
});

test("two messages add up, subagents cost but don't move context", () => {
  const tally = createTally();
  addToTally(tally, [
    { type: "assistant", message: { id: "a", model: "claude-opus-5", usage } },
    { type: "assistant", parent_tool_use_id: "toolu_1", message: { id: "b", model: "claude-haiku-4-5-20251001", usage: { input_tokens: 1_000_000 } } },
  ]);
  assert.equal(tally.cost, 68_760 / 1_000_000 + 1);
  assert.equal(tally.context, 101_002);
});

test("model labels drop the vendor prefix and date", () => {
  assert.equal(modelLabel("claude-opus-5"), "opus-5");
  assert.equal(modelLabel("claude-haiku-4-5-20251001"), "haiku-4-5");
  assert.equal(modelLabel(null), "");
});

test("a /model switch shows until the new model answers", () => {
  assert.equal(modelFromCommandOutput("Set model to Sonnet 5 for this session only"), "Sonnet 5");
  assert.equal(modelFromCommandOutput("Set model to Opus 5 and saved as your default for new sessions"), "Opus 5");
  const tally = createTally();
  addToTally(tally, [{ type: "assistant", message: { id: "a", model: "claude-opus-5", usage } }]);
  assert.equal(currentModelLabel(tally), "opus-5");
  addToTally(tally, [{ type: "user", message: { content: "<local-command-stdout>Set model to Sonnet 5 for this session only</local-command-stdout>" } }]);
  assert.equal(currentModelLabel(tally), "Sonnet 5");
  addToTally(tally, [{ type: "assistant", message: { id: "b", model: "claude-sonnet-5", usage } }]);
  assert.equal(currentModelLabel(tally), "sonnet-5");
});
