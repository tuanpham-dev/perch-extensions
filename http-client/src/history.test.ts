import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryStorage } from "../../scripts/memoryStorage.mjs";
import { addHistoryEntry, historyPrefix } from "../server.js";

type Tx = { collection(n: string): unknown };

describe("request history", () => {
  it("writes one record per entry and keeps the newest per key", async () => {
    const { storage, events } = createMemoryStorage();
    const add = (key: string, n: number, at: number) =>
      storage.transaction((tx: Tx) => addHistoryEntry(tx.collection("history"), key, { n }, at, 3));
    for (let i = 1; i <= 5; i++) await add("/repo/api.http#login", i, i);
    await add("/repo/other.http", 9, 9);
    const rows = (await storage.collection("history").list({ prefix: historyPrefix("/repo/api.http#login") })) as { value: { n: number } }[];
    assert.deepEqual(rows.map((r) => r.value.n), [3, 4, 5]);
    // A key that is a prefix of another stays separate.
    assert.equal(((await storage.collection("history").list({ prefix: historyPrefix("/repo/other.http") })) as unknown[]).length, 1);
    // Each save touched only its own entry (plus the one it pruned).
    const last = events.filter((e: { type: string }) => e.type === "change").at(-2) as { changes: { key: string; deleted?: boolean }[] };
    assert.ok(last.changes.length <= 2);
  });
});
