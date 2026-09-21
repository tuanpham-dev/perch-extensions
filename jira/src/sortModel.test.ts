import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SORT,
  DEFAULT_VIEW,
  parseViewStore,
  readView,
  serializeViewStore,
  sortParams,
  toggleSort,
  writeView,
} from "./sortModel.ts";

test("clicking the sorted heading again flips its direction", () => {
  assert.deepEqual(toggleSort({ field: "key", dir: "asc" }, "key"), { field: "key", dir: "desc" });
  assert.deepEqual(toggleSort({ field: "key", dir: "desc" }, "key"), { field: "key", dir: "asc" });
});

test("a new text field starts A to Z", () => {
  assert.deepEqual(toggleSort(DEFAULT_SORT, "summary"), { field: "summary", dir: "asc" });
});

test("a new date or priority field starts highest first", () => {
  assert.deepEqual(toggleSort({ field: "key", dir: "asc" }, "created"), { field: "created", dir: "desc" });
  assert.deepEqual(toggleSort({ field: "key", dir: "asc" }, "priority"), { field: "priority", dir: "desc" });
});

test("the default sort sends no parameters, so the query is unchanged", () => {
  assert.deepEqual(sortParams(DEFAULT_SORT), []);
});

test("any other sort sends its field and direction", () => {
  assert.deepEqual(sortParams({ field: "key", dir: "asc" }), [
    ["sort", "key"],
    ["dir", "asc"],
  ]);
});

test("a view survives a round trip through the setting", () => {
  const view = { sort: { field: "key" as const, dir: "asc" as const }, groupByProject: true };
  const store = parseViewStore(serializeViewStore(writeView({}, "/works/acme", "mine", view)));
  assert.deepEqual(readView(store, "/works/acme", "mine"), view);
});

test("each repo and list keeps its own view", () => {
  let store = writeView({}, "/a", "mine", { sort: DEFAULT_SORT, groupByProject: true });
  store = writeView(store, "/a", "project", { sort: { field: "key", dir: "asc" }, groupByProject: false });
  assert.equal(readView(store, "/a", "mine").groupByProject, true);
  assert.equal(readView(store, "/a", "project").sort.field, "key");
  assert.deepEqual(readView(store, "/b", "mine"), DEFAULT_VIEW);
});

test("a view back at the default is pruned, and so is an emptied repo", () => {
  let store = writeView({}, "/a", "mine", { sort: DEFAULT_SORT, groupByProject: true });
  store = writeView(store, "/a", "mine", DEFAULT_VIEW);
  assert.deepEqual(store, {});
});

test("a mangled setting reads as nothing saved", () => {
  for (const raw of ["{nope", "[]", 3, "", null]) assert.deepEqual(parseViewStore(raw), {});
});

test("an unknown sort field is dropped back to the default rather than trusted", () => {
  const store = parseViewStore(JSON.stringify({ "/a": { mine: { sort: { field: "evil", dir: "asc" }, groupByProject: true } } }));
  assert.equal(readView(store, "/a", "mine").sort.field, "updated");
  assert.equal(readView(store, "/a", "mine").groupByProject, true);
});

test("no active repo reads the default view", () => {
  assert.equal(readView({}, null, "mine"), DEFAULT_VIEW);
});
