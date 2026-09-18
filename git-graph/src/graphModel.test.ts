// Lane assignment, checked against graphs drawn by hand. Runs under
// `node --test --experimental-strip-types` (see package.json's test script).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layoutGraph, maxLanes, type GraphCommit } from "./graphModel.ts";

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
    // narrow as git's own --graph.
    const converge = byHash.Y.edges.find((e) => e.kind === "converge");
    assert.ok(converge, "the second lane is collapsed as soon as both wait for Z");
    assert.equal(converge.fromLane, 1);
    assert.equal(converge.toLane, 0);
    assert.deepEqual(byHash.Z.edges, [], "so Z's own row has nothing left to join");
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
    assert.deepEqual(last.edges, [], "a root commit has nothing below it");
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
