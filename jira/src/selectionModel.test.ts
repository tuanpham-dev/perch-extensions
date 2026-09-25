// Row selection: the gestures the panes offer all reduce to these four
// operations, so the cases below are named for the gesture that reaches them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMarquee, orderedSelection, prune, rangeOf, selectRange, toggle, parseIssueKeys } from "./selectionModel.ts";

const KEYS = ["CAP-1", "CAP-2", "CAP-3", "CAP-4", "CAP-5"];

const set = (...keys: string[]) => new Set(keys);
const sorted = (s: ReadonlySet<string>) => [...s].sort();

// ---- Ctrl-click ----

test("ctrl-clicking an unselected row adds it", () => {
  assert.deepEqual(sorted(toggle(set("CAP-1"), "CAP-2")), ["CAP-1", "CAP-2"]);
});

test("ctrl-clicking a selected row removes it", () => {
  assert.deepEqual(sorted(toggle(set("CAP-1", "CAP-2"), "CAP-1")), ["CAP-2"]);
});

test("toggling returns a new set, so React sees the change", () => {
  const before = set("CAP-1");
  assert.notEqual(toggle(before, "CAP-2"), before);
  assert.deepEqual(sorted(before), ["CAP-1"]);
});

// ---- Shift-click ----

test("a shift range is the same rows whichever direction it is drawn", () => {
  assert.deepEqual(rangeOf(KEYS, "CAP-2", "CAP-4"), ["CAP-2", "CAP-3", "CAP-4"]);
  assert.deepEqual(rangeOf(KEYS, "CAP-4", "CAP-2"), ["CAP-2", "CAP-3", "CAP-4"]);
});

test("a shift range includes both ends", () => {
  assert.deepEqual(rangeOf(KEYS, "CAP-3", "CAP-3"), ["CAP-3"]);
});

test("shift-clicking with no anchor yet picks just that row", () => {
  assert.deepEqual(rangeOf(KEYS, null, "CAP-3"), ["CAP-3"]);
});

test("an anchor that has since been filtered away picks just the clicked row", () => {
  assert.deepEqual(rangeOf(KEYS, "CAP-99", "CAP-3"), ["CAP-3"]);
});

test("a row the pane no longer lists selects nothing", () => {
  assert.deepEqual(rangeOf(KEYS, "CAP-1", "CAP-99"), []);
});

test("a shift range adds to what was already selected elsewhere", () => {
  const next = selectRange(set("CAP-5"), KEYS, "CAP-1", "CAP-2");
  assert.deepEqual(sorted(next), ["CAP-1", "CAP-2", "CAP-5"]);
});

// ---- Drag marquee ----

test("a plain drag replaces the selection", () => {
  assert.deepEqual(sorted(applyMarquee(set("CAP-5"), ["CAP-1", "CAP-2"], false)), ["CAP-1", "CAP-2"]);
});

test("a ctrl-held drag adds to the selection the drag started from", () => {
  assert.deepEqual(sorted(applyMarquee(set("CAP-5"), ["CAP-1"], true)), ["CAP-1", "CAP-5"]);
});

test("a shrinking band releases rows it has passed back over", () => {
  // Frame by frame against the SAME snapshot, which is what makes the band
  // able to shrink - unioning with the live selection would make it sticky.
  const base = set();
  const wide = applyMarquee(base, ["CAP-1", "CAP-2", "CAP-3"], false);
  const narrow = applyMarquee(base, ["CAP-1"], false);
  assert.deepEqual(sorted(wide), ["CAP-1", "CAP-2", "CAP-3"]);
  assert.deepEqual(sorted(narrow), ["CAP-1"]);
});

// ---- Refreshes ----

test("a refresh drops selected issues no pane lists any more", () => {
  assert.deepEqual(sorted(prune(set("CAP-1", "CAP-9"), KEYS)), ["CAP-1"]);
});

test("an issue listed by either pane survives the prune", () => {
  const mine = ["CAP-1"];
  const project = ["CAP-7"];
  assert.deepEqual(sorted(prune(set("CAP-1", "CAP-7"), [...mine, ...project])), ["CAP-1", "CAP-7"]);
});

// ---- Ordering ----

test("selected issues come back in the order the panes list them", () => {
  const mine = [{ key: "CAP-3" }, { key: "CAP-1" }];
  const project = [{ key: "CAP-2" }];
  const picked = orderedSelection([mine, project], set("CAP-1", "CAP-2", "CAP-3"));
  assert.deepEqual(
    picked.map((issue) => issue.key),
    ["CAP-3", "CAP-1", "CAP-2"],
  );
});

test("a ticket listed in both panes is returned once", () => {
  const mine = [{ key: "CAP-1" }];
  const project = [{ key: "CAP-1" }, { key: "CAP-2" }];
  const picked = orderedSelection([mine, project], set("CAP-1", "CAP-2"));
  assert.deepEqual(
    picked.map((issue) => issue.key),
    ["CAP-1", "CAP-2"],
  );
});

// ---- Pasted keys ----
//
// The shapes a list of keys actually arrives in: a comma list from a note, a
// column of lines from a spreadsheet, a URL copied out of a browser.

test("keys arrive as a comma list, a line per key, or a browse URL", () => {
  assert.deepEqual(parseIssueKeys("CAP-1, CAP-2").keys, ["CAP-1", "CAP-2"]);
  assert.deepEqual(parseIssueKeys("CAP-1\nCAP-2\n").keys, ["CAP-1", "CAP-2"]);
  assert.deepEqual(parseIssueKeys("CAP-1; CAP-2").keys, ["CAP-1", "CAP-2"]);
  assert.deepEqual(parseIssueKeys("https://x.atlassian.net/browse/OPS-41").keys, ["OPS-41"]);
  assert.deepEqual(parseIssueKeys("https://x.atlassian.net/browse/OPS-41/").keys, ["OPS-41"]);
});

test("a key is upper-cased and listed once, in the order written", () => {
  assert.deepEqual(parseIssueKeys("cap-2, CAP-1, cap-2").keys, ["CAP-2", "CAP-1"]);
});

test("what is not a key is reported rather than dropped", () => {
  const parsed = parseIssueKeys("CAP-1, nope, 123, CAP-, https://x/browse/nope");
  assert.deepEqual(parsed.keys, ["CAP-1"]);
  assert.deepEqual(parsed.invalid, ["nope", "123", "CAP-", "https://x/browse/nope"]);
});

test("an empty paste is empty, not an error", () => {
  assert.deepEqual(parseIssueKeys("   \n  ").keys, []);
  assert.deepEqual(parseIssueKeys("").invalid, []);
});
