import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryStorage } from "../../scripts/memoryStorage.mjs";
import { addHistory, historyKey } from "../server/index.mjs";

type Row = { key: string; value: { at: number; text: string } };

describe("query history", () => {
  it("keeps one record per query, newest last by key, deduplicated and capped", async () => {
    const { storage } = createMemoryStorage();
    const run = (text: string, at: number, limit = 3) =>
      storage.transaction((tx: { collection(n: string): unknown }) => addHistory(tx.collection("history"), "conn_a", text, at, limit));
    await run("select 1", 1);
    await run("select 2", 2);
    await run("select 1", 3);
    await run("select 3", 4);
    await run("select 4", 5);
    await storage.transaction((tx: { collection(n: string): unknown }) => addHistory(tx.collection("history"), "conn_b", "other", 6, 3));
    const rows = (await storage.collection("history").list({ prefix: "conn_a/" })) as Row[];
    assert.deepEqual(rows.map((r) => r.value.text), ["select 1", "select 3", "select 4"]);
    assert.equal(rows[0].key, historyKey("conn_a", 3));
    assert.equal(((await storage.collection("history").list({ prefix: "conn_b/" })) as Row[]).length, 1);
  });
});
