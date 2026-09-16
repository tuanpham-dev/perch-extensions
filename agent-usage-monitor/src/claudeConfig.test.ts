// The shape Claude Code 2.x caches in ~/.claude.json on 2026-09-15. Fields
// this doesn't read (limit_dollars, severity, is_active, the named buckets
// beside `limits`) are left out; what matters is the kind, the percent, the
// reset and the model a scoped week names.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { windowsFrom } from "../readers/claudeConfig.mjs";

const NOW = Date.parse("2026-09-15T22:40:00Z");

const cached = (limits: unknown[], fetchedAtMs = NOW - 7 * 60_000) => ({
  fetchedAtMs,
  utilization: { limits },
});

const SESSION = { kind: "session", percent: 47, resets_at: "2026-09-16T03:30:00.497476+00:00" };
const WEEK = { kind: "weekly_all", percent: 38, resets_at: "2026-09-20T16:00:00.497495+00:00" };
const FABLE = {
  kind: "weekly_scoped",
  percent: 32,
  resets_at: "2026-09-20T16:00:00.497678+00:00",
  scope: { model: { id: null, display_name: "Fable" }, surface: null },
};

describe("windowsFrom", () => {
  it("reads the session, the week, and a model's week", () => {
    assert.deepEqual(windowsFrom(cached([SESSION, WEEK, FABLE]), NOW), [
      { label: "5-hour", usedPercent: 47, resetsAt: Date.parse(SESSION.resets_at), scoped: false, scope: null },
      { label: "weekly", usedPercent: 38, resetsAt: Date.parse(WEEK.resets_at), scoped: false, scope: null },
      { label: "Fable weekly", usedPercent: 32, resetsAt: Date.parse(FABLE.resets_at), scoped: true, scope: "Fable" },
    ]);
  });

  it("drops a window that has already reset", () => {
    const past = { ...SESSION, resets_at: "2026-09-15T20:00:00+00:00" };
    assert.deepEqual(
      windowsFrom(cached([past, WEEK]), NOW).map((w) => w.label),
      ["weekly"],
    );
  });

  it("says nothing from a cache the CLI stopped refreshing", () => {
    assert.deepEqual(windowsFrom(cached([SESSION, WEEK, FABLE], NOW - 7 * 60 * 60_000), NOW), []);
  });

  it("ignores a scoped week with no model to name it", () => {
    const anonymous = { ...FABLE, scope: { model: null, surface: null } };
    assert.deepEqual(windowsFrom(cached([anonymous]), NOW), []);
  });

  it("keeps the first reading of a window", () => {
    const again = { ...FABLE, percent: 99 };
    assert.deepEqual(
      windowsFrom(cached([FABLE, again]), NOW).map((w) => w.usedPercent),
      [32],
    );
  });

  it("says nothing about a config it can't read", () => {
    assert.deepEqual(windowsFrom(undefined, NOW), []);
    assert.deepEqual(windowsFrom({}, NOW), []);
    assert.deepEqual(windowsFrom(cached("not a list" as unknown as unknown[]), NOW), []);
  });
});
