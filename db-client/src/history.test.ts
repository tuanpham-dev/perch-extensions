import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryStorage } from "../../scripts/memoryStorage.mjs";
import { addHistory, clearHistory, filterHistory, historyKey } from "../server/index.mjs";

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

  it("searches case-insensitively, MongoDB specs by their unescaped text too", () => {
    const entries = [
      { at: 3, text: "SELECT * FROM users" },
      { at: 2, text: "BLPOP jobs 0" },
      { at: 1, text: JSON.stringify({ collection: "docs", filter: '{"status":"active"}' }) },
    ];
    assert.deepEqual(filterHistory(entries, "").length, 3);
    assert.deepEqual(filterHistory(entries, "  from USERS ").map((e) => e.at), [3]);
    assert.deepEqual(filterHistory(entries, "blpop").map((e) => e.at), [2]);
    assert.deepEqual(filterHistory(entries, '"status":"active"').map((e) => e.at), [1]);
    assert.deepEqual(filterHistory(entries, "nothing like this"), []);
  });

  it("clears one connection's history and leaves the others", async () => {
    const { storage } = createMemoryStorage();
    await storage.transaction((tx: { collection(n: string): unknown }) => {
      const h = tx.collection("history");
      addHistory(h, "conn_a", "a1", 1);
      addHistory(h, "conn_a", "a2", 2);
      addHistory(h, "conn_ab", "ab", 3);
    });
    await storage.transaction((tx: { collection(n: string): unknown }) => clearHistory(tx.collection("history"), "conn_a"));
    assert.equal(((await storage.collection("history").list({ prefix: "conn_a/" })) as Row[]).length, 0);
    assert.equal(((await storage.collection("history").list({ prefix: "conn_ab/" })) as Row[]).length, 1);
  });
});
