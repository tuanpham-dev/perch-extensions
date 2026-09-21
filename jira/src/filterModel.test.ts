// The panel's filter state and the jira.filters setting it is remembered in.
// Each case names the situation it protects rather than the mapping it
// asserts, the way agent-tasks' model.test.ts does.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_FILTERS,
  UNASSIGNED,
  activeCount,
  chipsOf,
  filterParams,
  isEmpty,
  parseFilterStore,
  readFilters,
  removeValue,
  serializeFilterStore,
  setText,
  toggleValue,
  writeFilters,
  type FilterStore,
  type IssueFilters,
} from "./filterModel.ts";
import type { Facets } from "./types.ts";

const FACETS: Facets = {
  statuses: [{ name: "In Review", category: "indeterminate" }],
  assignees: [{ accountId: "557058:ab", displayName: "Dana Okafor" }],
  types: [{ name: "Bug" }],
  priorities: [{ name: "High" }],
};

function filters(patch: Partial<IssueFilters> = {}): IssueFilters {
  return { ...EMPTY_FILTERS, ...patch };
}

// ---- Selections ----

test("the badge counts every ticked value, not every facet", () => {
  const f = filters({ status: ["To Do", "In Review"], type: ["Bug"] });
  assert.equal(activeCount(f), 3);
});

test("the search box counts as one active filter", () => {
  assert.equal(activeCount(filters({ text: "header" })), 1);
  assert.equal(activeCount(filters({ text: "" })), 0);
});

test("toggling the same value twice returns to empty", () => {
  const once = toggleValue(EMPTY_FILTERS, "status", "In Review");
  assert.deepEqual(once.status, ["In Review"]);
  assert.ok(isEmpty(toggleValue(once, "status", "In Review")));
});

test("toggling does not mutate the filters it was given", () => {
  const before = filters({ status: ["To Do"] });
  toggleValue(before, "status", "In Review");
  assert.deepEqual(before.status, ["To Do"]);
});

test("removing a value leaves the other facets alone", () => {
  const f = filters({ status: ["To Do", "In Review"], type: ["Bug"] });
  const next = removeValue(f, "status", "To Do");
  assert.deepEqual(next.status, ["In Review"]);
  assert.deepEqual(next.type, ["Bug"]);
});

// ---- Request parameters ----

test("each ticked value becomes its own repeated parameter", () => {
  const f = filters({ status: ["In Review", "Blocked"], type: ["Bug"], text: "nav" });
  assert.deepEqual(filterParams(f), [
    ["status", "In Review"],
    ["status", "Blocked"],
    ["type", "Bug"],
    ["text", "nav"],
  ]);
});

test("an empty search box sends no text parameter", () => {
  assert.deepEqual(filterParams(EMPTY_FILTERS), []);
});

test("a status name containing a comma survives as one value", () => {
  const params = filterParams(filters({ status: ["Waiting, blocked"] }));
  assert.deepEqual(params, [["status", "Waiting, blocked"]]);
});

// ---- Chips ----

test("an assignee chip shows the display name, not the accountId", () => {
  const chips = chipsOf(filters({ assignee: ["557058:ab"] }), FACETS);
  assert.deepEqual(
    chips.map((chip) => chip.label),
    ["Dana Okafor"],
  );
});

test("an assignee chip falls back to the raw value before the facets load", () => {
  const chips = chipsOf(filters({ assignee: ["557058:ab"] }), null);
  assert.equal(chips[0].label, "557058:ab");
});

test("the unassigned sentinel reads as a word", () => {
  const chips = chipsOf(filters({ assignee: [UNASSIGNED] }), FACETS);
  assert.equal(chips[0].label, "Unassigned");
});

test("the search term is chipped first, so clearing it is always in the same place", () => {
  const chips = chipsOf(filters({ status: ["In Review"], text: "nav" }), FACETS);
  assert.equal(chips[0].facet, "text");
  assert.equal(chips[0].label, '"nav"');
});

// ---- The jira.filters store ----

test("filters survive a round trip through the settings document", () => {
  const saved = writeFilters({}, "/works/acme", "project", filters({ status: ["In Review"] }));
  const reread = parseFilterStore(serializeFilterStore(saved));
  assert.deepEqual(readFilters(reread, "/works/acme", "project").status, ["In Review"]);
});

test("each repo and each pane keeps its own filters", () => {
  let store: FilterStore = {};
  store = writeFilters(store, "/works/acme", "project", filters({ status: ["In Review"] }));
  store = writeFilters(store, "/works/acme", "mine", filters({ type: ["Bug"] }));
  store = writeFilters(store, "/works/shop", "project", filters({ status: ["Blocked"] }));

  assert.deepEqual(readFilters(store, "/works/acme", "project").status, ["In Review"]);
  assert.deepEqual(readFilters(store, "/works/acme", "mine").type, ["Bug"]);
  assert.deepEqual(readFilters(store, "/works/shop", "project").status, ["Blocked"]);
  assert.ok(isEmpty(readFilters(store, "/works/shop", "mine")));
});

test("clearing a pane drops its entry, and the repo once nothing is left", () => {
  let store = writeFilters({}, "/works/acme", "project", filters({ status: ["In Review"] }));
  store = writeFilters(store, "/works/acme", "mine", filters({ type: ["Bug"] }));
  store = writeFilters(store, "/works/acme", "project", EMPTY_FILTERS);
  assert.deepEqual(Object.keys(store["/works/acme"]), ["mine"]);

  store = writeFilters(store, "/works/acme", "mine", EMPTY_FILTERS);
  assert.deepEqual(store, {});
});

test("a repo with no saved filters reads as empty rather than undefined", () => {
  assert.equal(readFilters({}, "/works/never-opened", "project"), EMPTY_FILTERS);
});

test("no active window means no filters, not a crash", () => {
  assert.ok(isEmpty(readFilters({}, null, "mine")));
});

test("a hand-mangled setting reads as nothing saved rather than throwing", () => {
  assert.deepEqual(parseFilterStore("{not json"), {});
  assert.deepEqual(parseFilterStore("[]"), {});
  assert.deepEqual(parseFilterStore(42), {});
  assert.deepEqual(parseFilterStore(""), {});
  assert.deepEqual(parseFilterStore(undefined), {});
});

test("junk inside an otherwise valid entry is dropped, not trusted", () => {
  const store = parseFilterStore(
    JSON.stringify({ "/works/acme": { project: { status: ["In Review", 7], text: 3, bogus: "x" } } }),
  );
  const f = readFilters(store, "/works/acme", "project");
  assert.deepEqual(f.status, ["In Review"]);
  assert.equal(f.text, "");
});

test("an entry that sanitizes down to nothing does not resurrect the repo", () => {
  const store = parseFilterStore(JSON.stringify({ "/works/acme": { project: { status: [] } } }));
  assert.deepEqual(store, {});
});

test("an already-parsed object is accepted, so a caller need not re-stringify", () => {
  const store = parseFilterStore({ "/works/acme": { mine: { ...EMPTY_FILTERS, text: "nav" } } });
  assert.equal(readFilters(store, "/works/acme", "mine").text, "nav");
});

test("setText replaces rather than appends", () => {
  assert.equal(setText(filters({ text: "old" }), "new").text, "new");
});
