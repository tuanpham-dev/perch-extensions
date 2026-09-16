import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCostState, readCostState, spendFrom, TAIL_BYTES } from "../costState.mjs";

const costLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "cost-state",
    sessionId: "s1",
    startTime: 1_700_000_000_000,
    totalCostUSD: 3.5,
    modelUsage: { "claude-opus-5": { costUSD: 3.5, inputTokens: 10, outputTokens: 20 } },
    ...over,
  });

const assistantLine = JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1 } } });

describe("parseCostState", () => {
  it("finds the record even with later lines after it", () => {
    const record = parseCostState([assistantLine, costLine(), assistantLine].join("\n"));
    assert.equal(record?.totalCostUSD, 3.5);
    assert.equal(record?.sessionId, "s1");
    assert.equal(record?.startTime, 1_700_000_000_000);
  });

  it("returns null when there is no cost-state line", () => {
    assert.equal(parseCostState([assistantLine, assistantLine].join("\n")), null);
  });

  it("skips a line the tail cut in half", () => {
    const cut = costLine().slice(40);
    assert.equal(parseCostState(cut), null);
    assert.equal(parseCostState([cut, costLine({ totalCostUSD: 9 })].join("\n"))?.totalCostUSD, 9);
  });

  it("accepts an ISO startTime and defaults a missing one to null", () => {
    assert.equal(parseCostState(costLine({ startTime: "2026-09-15T10:00:00.000Z" }))?.startTime, Date.parse("2026-09-15T10:00:00.000Z"));
    assert.equal(parseCostState(costLine({ startTime: undefined }))?.startTime, null);
  });

  it("carries the unknown-model-cost flag", () => {
    assert.equal(parseCostState(costLine({ hasUnknownModelCost: true }))?.hasUnknownModelCost, true);
    assert.equal(parseCostState(costLine())?.hasUnknownModelCost, false);
  });
});

describe("readCostState", () => {
  it("reads the record from the end of a file bigger than the tail", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "usage-"));
    const file = path.join(dir, "session.jsonl");
    const filler = `${assistantLine}\n`.repeat(Math.ceil(TAIL_BYTES / assistantLine.length) + 100);
    await writeFile(file, `${filler}${costLine()}\n`);
    const record = await readCostState(file);
    assert.equal(record?.totalCostUSD, 3.5);
  });

  it("returns null for an empty or missing file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "usage-"));
    const empty = path.join(dir, "empty.jsonl");
    await writeFile(empty, "");
    assert.equal(await readCostState(empty), null);
    assert.equal(await readCostState(path.join(dir, "gone.jsonl")), null);
  });
});

describe("spendFrom", () => {
  // 2026-09-15 14:00 local, so "today" starts at 2026-09-15 00:00 local.
  const now = new Date(2026, 8, 15, 14, 0, 0).getTime();
  const at = (ms: number) => ({ totalCostUSD: 1, startTime: ms, hasUnknownModelCost: false });

  it("splits today from the last 7 days", () => {
    const spend = spendFrom(
      [
        at(new Date(2026, 8, 15, 9, 0, 0).getTime()), // today
        at(new Date(2026, 8, 14, 23, 59, 0).getTime()), // yesterday, still this week
        at(new Date(2026, 8, 1, 9, 0, 0).getTime()), // older than 7 days
      ],
      now,
    );
    assert.equal(spend.today, 1);
    assert.equal(spend.last7Days, 2);
    assert.equal(spend.sessions, 2);
  });

  it("counts a session that started just after local midnight as today", () => {
    const spend = spendFrom([at(new Date(2026, 8, 15, 0, 1, 0).getTime())], now);
    assert.equal(spend.today, 1);
  });

  it("ignores records with no cost, no start, or a start in the future", () => {
    const spend = spendFrom(
      [
        { totalCostUSD: "3", startTime: now } as never,
        { totalCostUSD: 1, startTime: null } as never,
        at(now + 60_000),
      ],
      now,
    );
    assert.equal(spend.today, 0);
    assert.equal(spend.last7Days, 0);
  });

  it("flags a partial total when a counted session priced an unknown model", () => {
    const spend = spendFrom([{ totalCostUSD: 2, startTime: now - 1000, hasUnknownModelCost: true }], now);
    assert.equal(spend.partial, true);
    assert.equal(spend.last7Days, 2);
  });
});

describe("spendFrom dating", () => {
  const now = new Date(2026, 8, 15, 14, 0, 0).getTime();

  it("counts a long session on the day it was last active, not the day it started", () => {
    const record = {
      totalCostUSD: 5,
      startTime: new Date(2026, 8, 12, 9, 0, 0).getTime(),
      at: new Date(2026, 8, 15, 11, 0, 0).getTime(),
      hasUnknownModelCost: false,
    };
    const spend = spendFrom([record], now);
    assert.equal(spend.today, 5);
    assert.equal(spend.last7Days, 5);
  });

  it("falls back to startTime when there is no activity time", () => {
    const spend = spendFrom(
      [{ totalCostUSD: 4, startTime: new Date(2026, 8, 15, 9, 0, 0).getTime(), hasUnknownModelCost: false }],
      now,
    );
    assert.equal(spend.today, 4);
  });
});
