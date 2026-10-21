// automations' run rules, pinned: loop prevention, the chain depth cap, the
// 20-run history and the origin records. The subject is the plain runs.mjs
// beside server.js; src/server.test.ts drives the same rules end to end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAIN_STOP_NOTE, MAX_CHAIN_DEPTH, RUN_HISTORY, childDepth, eventDecision, pushRun, rememberOrigin } from "../runs.mjs";

const automation = { id: "auto_a" };

test("an event from a task the automation made itself never starts it again", () => {
  assert.equal(eventDecision(automation, { automationId: "auto_a", depth: 1 }), "own");
  assert.equal(eventDecision(automation, { automationId: "auto_b", depth: 1 }), "run", "another automation's task does");
  assert.equal(eventDecision(automation, null), "run", "and so does a task no automation made");
});

test("chains stop at depth 3", () => {
  assert.equal(MAX_CHAIN_DEPTH, 3);
  assert.equal(childDepth(null), 1, "a run not started by an automation's task makes depth-1 tasks");
  assert.equal(childDepth({ depth: 2 }), 3);
  assert.equal(eventDecision(automation, { automationId: "auto_b", depth: 2 }), "run", "the third hop still runs");
  assert.equal(eventDecision(automation, { automationId: "auto_b", depth: 3 }), "depth", "a fourth does not");
  assert.match(CHAIN_STOP_NOTE, /stopped: chain depth 3 reached/);
  assert.equal(childDepth({ depth: "junk" }), 1, "a damaged record counts as no chain");
});

test("Pause All beats every other rule", () => {
  assert.equal(eventDecision(automation, null, { paused: true }), "paused");
  assert.equal(eventDecision(automation, { automationId: "auto_b", depth: 3 }, { paused: true }), "paused");
});

test("the last 20 runs are kept, newest first, mirrored onto last*", () => {
  assert.equal(RUN_HISTORY, 20);
  const entry: Record<string, any> = { runCount: 0 };
  for (let i = 1; i <= 25; i++) pushRun(entry, { at: i, status: "ok", reason: "manual", result: `run ${i}` });
  assert.equal(entry.runs.length, 20);
  assert.equal(entry.runs[0].result, "run 25");
  assert.equal(entry.runs[19].result, "run 6");
  assert.equal(entry.runCount, 25, "the count is every run, not just the kept ones");
  assert.deepEqual([entry.lastRunAt, entry.lastStatus, entry.lastResult], [25, "ok", "run 25"]);
  pushRun(entry, { at: 26, status: "stopped", reason: "event", result: CHAIN_STOP_NOTE }, { counted: false });
  assert.equal(entry.runCount, 25, "a stopped run is recorded but not counted");
  assert.equal(entry.lastStatus, "stopped");
});

test("an entry saved before the history existed keeps its last result as the first item", () => {
  const entry: Record<string, any> = { lastRunAt: 5, lastStatus: "error", lastReason: "schedule", lastResult: "boom", runCount: 3 };
  pushRun(entry, { at: 9, status: "ok", reason: "manual", result: "fine" });
  assert.deepEqual(
    entry.runs.map((r: { result: string }) => r.result),
    ["fine", "boom"],
  );
  const fresh: Record<string, any> = { lastRunAt: null, lastStatus: null };
  pushRun(fresh, { at: 1, status: "ok", reason: "manual", result: "first" });
  assert.equal(fresh.runs.length, 1, "a never-run entry gets no empty first item");
});

test("origins remember the newest tasks and forget the oldest", () => {
  const origins: Record<string, any> = {};
  for (let i = 1; i <= 6; i++) rememberOrigin(origins, `task_${i}`, { automationId: "auto_a", depth: 1, at: i }, 4);
  assert.deepEqual(Object.keys(origins).sort(), ["task_3", "task_4", "task_5", "task_6"]);
  assert.deepEqual(origins.task_6, { automationId: "auto_a", depth: 1, at: 6 });
});
