// The ticket-detail cache. A fake clock drives every case, so expiry is
// exact rather than timing-dependent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TtlCache } from "./ttlCache.ts";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("a fresh entry is served", () => {
  const c = clock();
  const cache = new TtlCache<string>({ ttlMs: () => 1000, max: 10, now: c.now });
  cache.set("CAP-1", "detail");
  c.advance(999);
  assert.equal(cache.get("CAP-1"), "detail");
});

test("an entry is not served once its TTL has passed", () => {
  const c = clock();
  const cache = new TtlCache<string>({ ttlMs: () => 1000, max: 10, now: c.now });
  cache.set("CAP-1", "detail");
  c.advance(1000);
  assert.equal(cache.get("CAP-1"), undefined);
  assert.equal(cache.size, 0, "an expired read also drops the entry");
});

test("a sweep clears expired entries nobody reads again", () => {
  const c = clock();
  const cache = new TtlCache<string>({ ttlMs: () => 1000, max: 10, now: c.now });
  cache.set("old", "a");
  c.advance(600);
  cache.set("new", "b");
  c.advance(500);
  cache.sweep();
  assert.equal(cache.size, 1);
  assert.equal(cache.get("new"), "b");
});

test("re-fetching a ticket restarts its TTL", () => {
  const c = clock();
  const cache = new TtlCache<string>({ ttlMs: () => 1000, max: 10, now: c.now });
  cache.set("CAP-1", "v1");
  c.advance(800);
  cache.set("CAP-1", "v2");
  c.advance(800);
  assert.equal(cache.get("CAP-1"), "v2");
});

test("reading does not extend the TTL", () => {
  const c = clock();
  const cache = new TtlCache<string>({ ttlMs: () => 1000, max: 10, now: c.now });
  cache.set("CAP-1", "detail");
  c.advance(600);
  cache.get("CAP-1");
  c.advance(600);
  assert.equal(cache.get("CAP-1"), undefined, "a ticket read often must still refresh eventually");
});

test("a TTL of 0 turns caching off entirely", () => {
  const cache = new TtlCache<string>({ ttlMs: () => 0, max: 10 });
  cache.set("CAP-1", "detail");
  assert.equal(cache.get("CAP-1"), undefined);
  assert.equal(cache.size, 0);
});

test("a TTL change applies to the next read", () => {
  const c = clock();
  let ttl = 10_000;
  const cache = new TtlCache<string>({ ttlMs: () => ttl, max: 10, now: c.now });
  cache.set("CAP-1", "detail");
  c.advance(2000);
  ttl = 1000;
  assert.equal(cache.get("CAP-1"), undefined);
});

test("the cap evicts the least recently used entry", () => {
  const cache = new TtlCache<string>({ ttlMs: () => 60_000, max: 2 });
  cache.set("a", "1");
  cache.set("b", "2");
  cache.get("a");
  cache.set("c", "3");
  assert.equal(cache.get("b"), undefined, "b was the least recently used");
  assert.equal(cache.get("a"), "1");
  assert.equal(cache.get("c"), "3");
});

test("delete and clear forget entries", () => {
  const cache = new TtlCache<string>({ ttlMs: () => 60_000, max: 10 });
  cache.set("a", "1");
  cache.set("b", "2");
  cache.delete("a");
  assert.equal(cache.get("a"), undefined);
  cache.clear();
  assert.equal(cache.size, 0);
});
