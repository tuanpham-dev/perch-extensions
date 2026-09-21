// jira.projectMap as the picker and the Settings table edit it. The setting
// is shared with server.js's resolveProjectKey, so the cases here are mostly
// about not corrupting a value the user may have typed by hand.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseProjectMap,
  projectKeyFor,
  removeProjectMap,
  serializeProjectMap,
  upsertProjectMap,
} from "./projectMap.ts";

test("an empty setting is no mapping, not a broken one", () => {
  for (const raw of ["", "   ", undefined, null]) {
    const parsed = parseProjectMap(raw);
    assert.deepEqual(parsed.entries, []);
    assert.equal(parsed.malformed, false);
  }
});

test("a mapping round-trips through the setting", () => {
  const entries = upsertProjectMap([], "/works/acme", "CAP");
  const reread = parseProjectMap(serializeProjectMap(entries));
  assert.equal(projectKeyFor(reread.entries, "/works/acme"), "CAP");
});

test("a project key is stored uppercase, however it was picked", () => {
  const entries = upsertProjectMap([], "/works/acme", " cap ");
  assert.equal(entries[0].key, "CAP");
});

test("a trailing slash is the same repo, not a second entry", () => {
  let entries = upsertProjectMap([], "/works/acme", "CAP");
  entries = upsertProjectMap(entries, "/works/acme/", "MAW");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, "MAW");
  assert.equal(projectKeyFor(entries, "/works/acme"), "MAW");
});

test("re-picking a project keeps the row where it was", () => {
  let entries = upsertProjectMap([], "/works/a", "AAA");
  entries = upsertProjectMap(entries, "/works/b", "BBB");
  entries = upsertProjectMap(entries, "/works/c", "CCC");
  entries = upsertProjectMap(entries, "/works/b", "ZZZ");
  assert.deepEqual(
    entries.map((entry) => entry.repo),
    ["/works/a", "/works/b", "/works/c"],
  );
  assert.equal(entries[1].key, "ZZZ");
});

test("removing an entry leaves the rest", () => {
  let entries = upsertProjectMap([], "/works/a", "AAA");
  entries = upsertProjectMap(entries, "/works/b", "BBB");
  entries = removeProjectMap(entries, "/works/a");
  assert.deepEqual(
    entries.map((entry) => entry.repo),
    ["/works/b"],
  );
});

test("removing a repo that was never mapped changes nothing", () => {
  const entries = upsertProjectMap([], "/works/a", "AAA");
  assert.deepEqual(removeProjectMap(entries, "/works/never"), entries);
});

test("an unmapped repo has no key", () => {
  assert.equal(projectKeyFor([], "/works/acme"), null);
  assert.equal(projectKeyFor(upsertProjectMap([], "/works/a", "AAA"), null), null);
});

test("a value that is not a mapping is reported, never silently emptied", () => {
  for (const raw of ["{not json", "[]", '"CAP"', "42"]) {
    const parsed = parseProjectMap(raw);
    assert.equal(parsed.malformed, true, `expected ${raw} to be reported`);
    assert.deepEqual(parsed.entries, []);
  }
});

test("one non-string value condemns the setting rather than dropping that line", () => {
  const parsed = parseProjectMap(JSON.stringify({ "/works/a": "AAA", "/works/b": 7 }));
  assert.equal(parsed.malformed, true);
  assert.deepEqual(parsed.entries, []);
});

test("an already-parsed object is accepted", () => {
  const parsed = parseProjectMap({ "/works/acme": "cap" });
  assert.equal(parsed.malformed, false);
  assert.equal(projectKeyFor(parsed.entries, "/works/acme"), "CAP");
});
