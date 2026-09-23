import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatItem } from "./chatModel.ts";
import { createPending, pendingItems, PENDING_TIMEOUT_MS, resolvePending } from "./pending.ts";

const userItem = (text: string): ChatItem => ({ kind: "text", role: "user", text, key: `k${text}` });
const assistantItem = (text: string): ChatItem => ({ kind: "text", role: "assistant", text, key: `a${text}` });

test("a pending message stays until its own entry arrives", () => {
  const items: ChatItem[] = [userItem("hello"), assistantItem("hi")];
  const p = createPending(items, [], "also check the logs", "p1", 0);
  assert.deepEqual(resolvePending([p], items, 1000), [p]);
  const withEntry = [...items, userItem("also check the logs")];
  assert.deepEqual(resolvePending([p], withEntry, 2000), []);
});

test("an identical earlier message doesn't resolve it", () => {
  const items: ChatItem[] = [userItem("run the tests")];
  const p = createPending(items, [], "run the tests", "p1", 0);
  assert.deepEqual(resolvePending([p], items, 1000), [p]);
  assert.deepEqual(resolvePending([p], [...items, userItem("run the tests")], 1000), []);
});

test("the same text sent twice needs two entries", () => {
  const items: ChatItem[] = [];
  const first = createPending(items, [], "again", "p1", 0);
  const second = createPending(items, [first], "again", "p2", 0);
  const one = resolvePending([first, second], [userItem("again")], 1000);
  assert.deepEqual(one.map((p) => p.key), ["p2"]);
  assert.deepEqual(resolvePending(one, [userItem("again"), userItem("again")], 2000), []);
});

test("an assistant message with the same text doesn't resolve it", () => {
  const p = createPending([], [], "done", "p1", 0);
  assert.deepEqual(resolvePending([p], [assistantItem("done")], 1000), [p]);
});

test("a message nothing ever claims is given up on", () => {
  const p = createPending([], [], "into the void", "p1", 0);
  assert.deepEqual(resolvePending([p], [], PENDING_TIMEOUT_MS - 1), [p]);
  assert.deepEqual(resolvePending([p], [], PENDING_TIMEOUT_MS + 1), []);
});

test("keeps the same array when nothing resolved, for a cheap re-render check", () => {
  const list = [createPending([], [], "x", "p1", 0)];
  assert.equal(resolvePending(list, [], 1000), list);
  assert.equal(resolvePending([], [], 1000).length, 0);
});

test("renders as user text rows marked pending", () => {
  const rows = pendingItems([createPending([], [], "queued text", "p1", 0)]);
  assert.deepEqual(rows, [{ kind: "text", role: "user", text: "queued text", pending: true, key: "p1" }]);
});
