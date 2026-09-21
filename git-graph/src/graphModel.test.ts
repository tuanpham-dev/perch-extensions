// Lane assignment, checked against graphs drawn by hand. Runs under
// `node --test --experimental-strip-types` (see package.json's test script).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layoutGraph, maxLanes, WIP_COLOR, type GraphCommit } from "./graphModel.ts";

const c = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents });

describe("layoutGraph", () => {
  it("keeps a linear history in one lane", () => {
    //  A - B - C
    const rows = layoutGraph([c("A", "B"), c("B", "C"), c("C")]);
    assert.deepEqual(
      rows.map((r) => r.lane),
      [0, 0, 0],
    );
    assert.equal(maxLanes(rows), 1);
    // Every lane keeps the colour it was born with.
    assert.equal(new Set(rows.map((r) => r.color)).size, 1);
  });

  it("gives a merge's second parent its own lane, and frees it at the join", () => {
    //  M      lane 0, merges S
    //  |\
    //  A S    A lane 0, S lane 1
    //  |/
    //  B      both land back on lane 0
    const rows = layoutGraph([c("M", "A", "S"), c("A", "B"), c("S", "B"), c("B")]);
    const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]));
    assert.equal(byHash.M.lane, 0);
    assert.equal(byHash.A.lane, 0);
    assert.equal(byHash.S.lane, 1, "the side branch takes a second lane");
    assert.equal(byHash.B.lane, 0, "and the graph narrows again once it merges");
    assert.equal(maxLanes(rows), 2);

    // M's edges: its own lane continues to A, plus a merge edge to S's lane.
    const merge = byHash.M.edges.find((e) => e.kind === "merge");
    assert.ok(merge, "the merge commit records an edge to its second parent");
    assert.equal(merge.fromLane, 0);
    assert.equal(merge.toLane, 1);
    // The second parent's lane gets its own colour, not the first parent's.
    assert.notEqual(merge.color, byHash.M.color);
  });

  it("keeps two concurrent branches in separate lanes and collapses them at once", () => {
    //  X      tip of one branch (lane 0)
    //  |   Y  tip of another (lane 1)
    //  |  /   both now wait for Z, so lane 1 ends on Y's own row
    //  Z      shared ancestor, drawn in the surviving lane
    const rows = layoutGraph([c("X", "Z"), c("Y", "Z"), c("Z")]);
    const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]));
    assert.equal(byHash.X.lane, 0);
    assert.equal(byHash.Y.lane, 1);
    assert.equal(byHash.Z.lane, 0);

    // The convergence is drawn on the row where it becomes known - Y's -
    // not held open until Z is reached. That is what keeps the graph as
    // narrow as git's own --graph. Y's lane was born on Y's own row, so the
    // join leaves Y's dot rather than the top edge of a lane that was not
    // there yet, and Y records no straight edge into a lane that ends here.
    assert.deepEqual(
      byHash.Y.edges,
      [{ fromLane: 1, toLane: 0, color: 1, kind: "merge" }],
      "the second lane is collapsed as soon as both wait for Z",
    );
    assert.deepEqual(
      byHash.Z.edges,
      [{ fromLane: 0, toLane: 0, color: 0, kind: "branch" }],
      "so Z's own row only has to join the lane arriving from above",
    );
  });

  it("leaves no stub below a lane that ends on the row it was born", () => {
    //  X      lane 0, waiting for P
    //  Y      a tip whose parent is P too: it takes lane 1 and gives it up
    //         on the same row
    //  P
    const rows = layoutGraph([c("X", "P"), c("Y", "P"), c("P")]);
    const y = rows[1];
    assert.equal(
      y.edges.some((e) => e.kind === "straight"),
      false,
      "a straight edge here would be drawn down into a lane that no longer exists",
    );
    assert.equal(
      y.edges.some((e) => e.kind === "converge"),
      false,
      "and a converge would be drawn from the top edge, above a dot with nothing above it",
    );
    assert.deepEqual(
      y.edges.map((e) => `${e.kind}:${e.fromLane}->${e.toLane}`),
      ["merge:1->0"],
    );
  });

  it("frees a collapsed lane for the next unrelated tip", () => {
    //  X      lane 0, parent Z
    //  Y      lane 1, parent Z - collapses into lane 0 here
    //  W      an unrelated tip: it should reuse lane 1, not open lane 2
    const rows = layoutGraph([c("X", "Z"), c("Y", "Z"), c("W", "V"), c("Z"), c("V")]);
    const byHash = Object.fromEntries(rows.map((r) => [r.hash, r]));
    assert.equal(byHash.W.lane, 1);
    assert.equal(maxLanes(rows), 2);
  });

  it("ends a root commit's lane instead of leaving it waiting", () => {
    const rows = layoutGraph([c("A", "B"), c("B")]);
    const last = rows[rows.length - 1];
    assert.equal(last.hash, "B");
    assert.deepEqual(
      last.edges,
      [{ fromLane: 0, toLane: 0, color: 0, kind: "branch" }],
      "a root commit is joined to the row above and has nothing below it",
    );
  });

  it("joins every dot to the row above it", () => {
    // The rail down a column is drawn in two halves: each row's "straight"
    // edge from its dot to its bottom edge, and the next row's "branch" edge
    // from its top edge to its dot. Missing the second half left a gap above
    // every commit.
    const rows = layoutGraph([c("A", "B"), c("B", "C"), c("C", "D")]);
    const incoming = (i: number) =>
      rows[i].edges.some((e) => e.kind === "branch" && e.fromLane === rows[i].lane && e.toLane === rows[i].lane);
    assert.equal(incoming(0), false, "a branch tip has nothing above it to join");
    assert.equal(incoming(1), true);
    assert.equal(incoming(2), true);
  });

  it("joins a merge commit's dot both upward and along its parents", () => {
    //  A      the tip
    //  M      a merge below it: joined from above, and out to both parents
    const rows = layoutGraph([c("A", "M"), c("M", "B", "S"), c("B"), c("S")]);
    const kinds = rows[1].edges.map((e) => `${e.kind}:${e.fromLane}->${e.toLane}`);
    assert.deepEqual(kinds, ["branch:0->0", "straight:0->0", "merge:0->1"]);
  });

  it("draws a parent outside the loaded window as a continuing lane", () => {
    // Only A is loaded; its parent B is beyond the page, so A's lane still
    // leaves the row downward.
    const rows = layoutGraph([c("A", "B")]);
    assert.deepEqual(rows[0].edges, [{ fromLane: 0, toLane: 0, color: 0, kind: "straight" }]);
  });

  it("marks lanes that pass a row untouched", () => {
    //  X      lane 0
    //  |   Y  lane 1, still open while X's row is drawn
    const rows = layoutGraph([c("X", "P"), c("Y", "Q"), c("P"), c("Q")]);
    const yRow = rows.find((r) => r.hash === "Y");
    assert.ok(yRow);
    // While Y is drawn, X's lane (waiting for P) passes behind it.
    assert.deepEqual(
      yRow.through.map((t) => t.lane),
      [0],
    );
  });

  it("starts a merged-in branch's lane at the merge, not above it", () => {
    //  A        mainline
    //  M        the merge: it is what brings lane 1 into existence
    //  |\
    //  | B      the side branch's tip
    //  P        the shared parent
    const rows = layoutGraph([c("A", "M"), c("M", "P", "B"), c("B", "P"), c("P")]);
    const merge = rows[1];
    assert.deepEqual(
      merge.through,
      [],
      "drawing lane 1 behind this row would run the branch's column up past the commit that merged it",
    );
    assert.ok(merge.edges.some((e) => e.kind === "merge" && e.toLane === 1));
    // The row below it is where that lane legitimately starts passing.
    assert.deepEqual(rows[2].through, [{ lane: 0, color: 0 }]);
  });

  it("keeps a lane that a merge only joins among the pass-through lines", () => {
    //  Two tips, then a merge whose second parent is the lane the second tip
    //  is already waiting for: that lane was not opened here, so it still
    //  passes behind the row.
    const rows = layoutGraph([c("X", "P"), c("Y", "Q"), c("M", "P", "Q"), c("P"), c("Q")]);
    const merge = rows.find((r) => r.hash === "M");
    assert.ok(merge);
    assert.ok(
      merge.through.some((t) => t.lane === 1),
      "Q's lane runs from Y's row through this one",
    );
  });

  it("records the lanes crossing each row's bottom edge", () => {
    //  M      merge: lanes 0 and 1 both leave its bottom edge
    //  |\
    //  A B
    //  |/
    //  P      root: nothing leaves it
    const rows = layoutGraph([c("M", "A", "B"), c("A", "P"), c("B", "P"), c("P")]);
    assert.deepEqual(
      rows[0].below.map((b) => b.lane),
      [0, 1],
      "an expanded merge has to carry both lines through its file list",
    );
    assert.deepEqual(rows[rows.length - 1].below, [], "and a root commit carries none");
  });

  it("draws the uncommitted lane in the WIP colour and hands HEAD a real one", () => {
    //  *      Uncommitted Changes, parent HEAD
    //  H      HEAD
    //  P
    const rows = layoutGraph([{ hash: "WORKING", parents: ["H"], color: WIP_COLOR }, c("H", "P"), c("P")]);
    assert.equal(rows[0].color, WIP_COLOR);
    assert.equal(rows[0].below[0].color, WIP_COLOR, "the dashed line runs down to HEAD");
    assert.notEqual(rows[1].color, WIP_COLOR, "HEAD's own history is not work in progress");
    const incoming = rows[1].edges.find((e) => e.kind === "branch");
    assert.equal(incoming?.color, WIP_COLOR, "the segment arriving at HEAD is still the dashed one");
    const outgoing = rows[1].edges.find((e) => e.kind === "straight");
    assert.equal(outgoing?.color, rows[1].color);
  });

  it("returns nothing for no commits", () => {
    assert.deepEqual(layoutGraph([]), []);
    assert.equal(maxLanes([]), 1);
  });

  it("cycles lane colours within the palette", () => {
    // Twenty unrelated roots take twenty lanes; the colours wrap.
    const commits = Array.from({ length: 20 }, (_, i) => c(`R${i}`));
    const rows = layoutGraph(commits);
    assert.ok(rows.every((r) => r.color >= 0 && r.color < 12));
  });
});
