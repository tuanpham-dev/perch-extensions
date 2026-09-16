import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { limitsFrom, parseRollout } from "../readers/codex.mjs";
import { limitsFromAccount, todayTokensFromAccount, windowLabel } from "../readers/codexAppServer.mjs";

const tokenLine = (
  timestamp: string,
  total: number | null,
  over: Record<string, unknown> = {},
) =>
  JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info:
        total === null
          ? null
          : {
              total_token_usage: {
                total_tokens: total,
                input_tokens: total,
                output_tokens: Math.round(total / 10),
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
              },
            },
      ...over,
    },
  });

const sessionLine = JSON.stringify({
  timestamp: "2026-09-11T01:00:00.000Z",
  type: "session_meta",
  payload: { model: "gpt-5.6-terra", cwd: "/works/perch" },
});

describe("parseRollout", () => {
  it("turns cumulative totals into per-turn deltas", () => {
    const { entries } = parseRollout(
      [
        sessionLine,
        tokenLine("2026-09-11T01:01:00.000Z", 1000),
        tokenLine("2026-09-11T01:02:00.000Z", 2500),
      ].join("\n"),
    );
    assert.equal(entries.length, 2);
    assert.equal(entries[0].input + entries[0].output, 1000);
    assert.equal(entries[1].input + entries[1].output, 1500);
    assert.equal(entries[1].model, "gpt-5.6-terra");
  });

  it("skips lines whose info is null, and a half-written last line", () => {
    const { entries } = parseRollout(
      [
        sessionLine,
        tokenLine("2026-09-11T01:01:00.000Z", null),
        tokenLine("2026-09-11T01:02:00.000Z", 800),
        '{"timestamp":"2026-09-11T01:03:00.000Z","payload":{"type":"token',
      ].join("\n"),
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].input + entries[0].output, 800);
  });

  it("reports the session's model and folder", () => {
    const parsed = parseRollout([sessionLine, tokenLine("2026-09-11T01:01:00.000Z", 10)].join("\n"));
    assert.equal(parsed.model, "gpt-5.6-terra");
    assert.equal(parsed.cwd, "/works/perch");
  });

  it("keeps the newest rate limits it saw", () => {
    const parsed = parseRollout(
      [
        tokenLine("2026-09-11T01:01:00.000Z", 10, {
          rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 100 } },
        }),
        tokenLine("2026-09-11T01:02:00.000Z", 20, {
          rate_limits: { primary: { used_percent: 30, window_minutes: 300, resets_at: 200 } },
        }),
      ].join("\n"),
    );
    assert.equal(parsed.limits?.primary.used_percent, 30);
  });
});

describe("limitsFrom", () => {
  const now = 1_000_000_000_000;

  it("keeps the windows Codex filled in and drops the null ones", () => {
    const limits = limitsFrom(
      {
        primary: null,
        secondary: { used_percent: 42, window_minutes: 10080, resets_at: (now + 60_000) / 1000 },
      },
      now,
    );
    assert.deepEqual(limits, [{ label: "weekly", usedPercent: 42, resetsAt: now + 60_000 }]);
  });

  it("drops a window whose reset has already passed", () => {
    const limits = limitsFrom(
      { primary: { used_percent: 99, window_minutes: 43200, resets_at: (now - 60_000) / 1000 } },
      now,
    );
    assert.deepEqual(limits, []);
  });

  it("returns nothing when there is no limit block at all", () => {
    assert.deepEqual(limitsFrom(null, now), []);
    assert.deepEqual(limitsFrom({ limit_id: "premium", credits: {} }, now), []);
  });
});

describe("windowLabel", () => {
  it("names the windows Codex reports by length", () => {
    assert.equal(windowLabel(300), "5-hour");
    assert.equal(windowLabel(10080), "weekly");
    assert.equal(windowLabel(43200), "30-day");
    assert.equal(windowLabel(1440), "daily");
    assert.equal(windowLabel(undefined as never), "limit");
  });
});

describe("limitsFromAccount", () => {
  const now = 1_800_000_000_000;
  const account = (over: Record<string, unknown>) => ({ limits: { rateLimits: over } }) as never;

  it("turns Codex's own snapshot into limit rows", () => {
    const rows = limitsFromAccount(
      account({
        primary: { usedPercent: 100, windowDurationMins: 43200, resetsAt: (now + 3600_000) / 1000 },
        secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: (now + 7200_000) / 1000 },
      }),
      now,
    );
    assert.deepEqual(rows, [
      { label: "30-day", usedPercent: 100, resetsAt: now + 3600_000 },
      { label: "weekly", usedPercent: 12, resetsAt: now + 7200_000 },
    ]);
  });

  it("drops a window that has already reset, and a null one", () => {
    const rows = limitsFromAccount(
      account({
        primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: (now - 1000) / 1000 },
        secondary: null,
      }),
      now,
    );
    assert.deepEqual(rows, []);
  });

  it("returns nothing when the CLI could not be reached", () => {
    assert.deepEqual(limitsFromAccount(null as never, now), []);
    assert.deepEqual(limitsFromAccount({} as never, now), []);
  });
});

describe("todayTokensFromAccount", () => {
  it("picks today's bucket, by local date", () => {
    const now = new Date(2026, 8, 15, 14, 0, 0).getTime();
    const account = {
      usage: { dailyUsageBuckets: [{ startDate: "2026-09-14", tokens: 5 }, { startDate: "2026-09-15", tokens: 42 }] },
    } as never;
    assert.equal(todayTokensFromAccount(account, now), 42);
  });

  it("is null when today has no bucket, or there are none", () => {
    const now = new Date(2026, 8, 15, 14, 0, 0).getTime();
    assert.equal(todayTokensFromAccount({ usage: { dailyUsageBuckets: [] } } as never, now), null);
    assert.equal(todayTokensFromAccount(null as never, now), null);
  });
});
