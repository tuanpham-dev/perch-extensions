// Two Claude windows in one directory must resolve to their own sessions - the
// status dot used to read the newest transcript in the cwd for both. The map
// is keyed by the id host.sessions.list() gives a window, on either backend.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionsByWindow, windowIdFromEnviron, windowIdFromTmuxField } from "../claudePanes.mjs";

const alive = new Set([100, 200, 300]);
const isAlive = (pid: number) => alive.has(pid);
const rec = (pid: number, sessionId: string, tmux?: string, updatedAt = 1) => ({
  pid,
  sessionId,
  tmux,
  cwd: "/repo",
  updatedAt,
});

test("reads the window id from a process's environment", () => {
  assert.equal(windowIdFromEnviron(["HOME=/h", "PERCH_WINDOW=f0647411-cdfe"]), "f0647411-cdfe");
  // The tmux backend clears PERCH_WINDOW; its window id comes from the pane.
  assert.equal(windowIdFromEnviron(["PERCH_WINDOW=", "TMUX_PANE=%12"]), "tmux-12");
  assert.equal(windowIdFromEnviron(["TMUX_PANE=%12", "PERCH_WINDOW=w-1"]), "w-1");
  assert.equal(windowIdFromEnviron(["HOME=/h"]), null);
});

test("reads the tmux backend's window id from the record's tmux field", () => {
  assert.equal(windowIdFromTmuxField("perch-view-beb4b335:@0.%7"), "tmux-7");
  assert.equal(windowIdFromTmuxField(undefined), null);
});

test("two daemon sessions in the same directory stay on their own windows", () => {
  const windows = new Map([[100, "w-a"], [200, "w-b"]]);
  const map = sessionsByWindow([rec(100, "a"), rec(200, "b")], isAlive, windows);
  assert.equal(map.get("w-a").sessionId, "a");
  assert.equal(map.get("w-b").sessionId, "b");
});

test("tmux panes resolve by the record's tmux field when the environment is unreadable", () => {
  const map = sessionsByWindow([rec(100, "a", "s:@0.%0"), rec(200, "b", "s:@1.%25")], isAlive, new Map());
  assert.equal(map.get("tmux-0").sessionId, "a");
  assert.equal(map.get("tmux-25").sessionId, "b");
});

test("the environment wins over the tmux field", () => {
  // A daemon window started from inside tmux: the field names the outer pane.
  const map = sessionsByWindow([rec(100, "a", "s:@0.%0")], isAlive, new Map([[100, "w-a"]]));
  assert.equal(map.get("w-a").sessionId, "a");
  assert.equal(map.has("tmux-0"), false);
});

test("a record left behind by an exited CLI is ignored", () => {
  const windows = new Map([[999, "w"], [100, "w"]]);
  const map = sessionsByWindow([rec(999, "dead"), rec(100, "live")], isAlive, windows);
  assert.equal(map.get("w").sessionId, "live");
});

test("the most recently updated live record wins for a window", () => {
  const windows = new Map([[100, "w"], [300, "w"]]);
  const map = sessionsByWindow([rec(100, "old", undefined, 5), rec(300, "new", undefined, 9)], isAlive, windows);
  assert.equal(map.get("w").sessionId, "new");
});

test("records without a window or session id are skipped", () => {
  const windows = new Map([[200, "w"]]);
  const map = sessionsByWindow([rec(100, "x"), { pid: 200 }, null], isAlive, windows);
  assert.equal(map.size, 0);
});
