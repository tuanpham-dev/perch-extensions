import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONTEXT_WINDOW, LONG_CONTEXT_WINDOW, parseOverrides, windowFor } from "../contextWindow.mjs";
import { latestModel } from "../readers/claude.mjs";
import { parseRollout } from "../readers/codex.mjs";

describe("windowFor", () => {
  it("defaults to 200k", () => {
    assert.equal(windowFor("claude-opus-5-20260101"), DEFAULT_CONTEXT_WINDOW);
  });

  it("uses 1M for a 1M variant id", () => {
    assert.equal(windowFor("claude-opus-5[1m]"), LONG_CONTEXT_WINDOW);
  });

  it("uses 1M once a turn has sent more than 200k", () => {
    assert.equal(windowFor("claude-opus-5-5", {}, 250_000), LONG_CONTEXT_WINDOW);
    assert.equal(windowFor("claude-opus-5-5", {}, 124_000), DEFAULT_CONTEXT_WINDOW);
  });

  it("prefers an override from the setting", () => {
    const overrides = parseOverrides('{"claude-opus-5-5": 500000, "bad": -1, "worse": "x"}');
    assert.deepEqual(overrides, { "claude-opus-5-5": 500000 });
    assert.equal(windowFor("claude-opus-5-5", overrides, 250_000), 500_000);
  });

  it("ignores a malformed setting", () => {
    assert.deepEqual(parseOverrides("{not json"), {});
    assert.deepEqual(parseOverrides("[1,2]"), {});
    assert.deepEqual(parseOverrides(""), {});
  });
});

describe("context use from the transcripts", () => {
  it("counts a Claude turn's input, cache reads and cache writes", () => {
    const info = latestModel([
      { timestamp: 1, model: "claude-opus-5-20260101", input: 100, output: 5, cacheRead: 10, cacheCreation: 1 },
      { timestamp: 2, model: "claude-opus-5-20260101", input: 123_800, output: 20, cacheRead: 150, cacheCreation: 50 },
      { timestamp: 3, model: "unknown", input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
    ]);
    assert.deepEqual(info, { model: "claude-opus-5-20260101", contextTokens: 124_000, contextWindow: null });
  });

  it("takes Codex's last turn input and recorded window", () => {
    const line = (input: number, window?: number) =>
      JSON.stringify({
        timestamp: "2026-10-16T02:40:33.980Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: input, input_tokens: input, output_tokens: 0 },
            last_token_usage: { input_tokens: input },
            ...(window ? { model_context_window: window } : {}),
          },
        },
      });
    const parsed = parseRollout([line(13_770, 258_400), line(14_250)].join("\n"));
    assert.equal(parsed.contextTokens, 14_250);
    assert.equal(parsed.contextWindow, 258_400);
  });
});
