import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelLabel } from "./modelLabel.ts";

describe("modelLabel", () => {
  it("drops the vendor prefix", () => {
    assert.equal(modelLabel("claude-opus-5"), "opus-5");
    assert.equal(modelLabel("anthropic/claude-sonnet-5"), "claude-sonnet-5");
  });

  it("drops a trailing release date", () => {
    assert.equal(modelLabel("claude-haiku-4-5-20251001"), "haiku-4-5");
    assert.equal(modelLabel("claude-sonnet-5-2026-01-15"), "sonnet-5");
    assert.equal(modelLabel("claude-opus-5-latest"), "opus-5");
  });

  it("leaves an id it doesn't recognise alone", () => {
    assert.equal(modelLabel("gpt-5.6-terra"), "gpt-5.6-terra");
    assert.equal(modelLabel("some-local-model"), "some-local-model");
  });

  it("never trims a name to nothing", () => {
    assert.equal(modelLabel("claude-20251001"), "claude-20251001");
    assert.equal(modelLabel("   "), "");
    assert.equal(modelLabel(undefined as never), "");
  });
});
