// The filter's query shape and the search matcher, both of which decide what
// a user sees without any git of their own to check it against.
// Runs under `node --test --experimental-strip-types` (see package.json).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorSummary,
  branchSummary,
  defaultFilter,
  filterQuery,
  graphIsTruthful,
  matchIndexes,
  matchesQuery,
  type GraphFilter,
  type SearchableCommit,
} from "./filterModel.ts";

const base = (over: Partial<GraphFilter> = {}): GraphFilter => ({
  ...defaultFilter({ showRemotes: true, showTags: true, showStashes: true }),
  ...over,
});

const commit = (over: Partial<SearchableCommit> = {}): SearchableCommit => ({
  hash: "9f1c2d3e4b5a6978",
  author: "Tuan Pham",
  subject: "Fold a project's idle worktrees behind a Show more row",
  refs: [],
  ...over,
});

describe("filterQuery", () => {
  it("sends nothing but the basics for an unfiltered graph", () => {
    const params = filterQuery(base(), new URLSearchParams({ cwd: "/repo" }));
    assert.equal(params.toString(), "cwd=%2Frepo");
  });

  it("repeats a parameter per ref and per author", () => {
    const params = filterQuery(base({ refs: ["main", "origin/main"], authors: ["Tuan Pham"] }), new URLSearchParams());
    assert.deepEqual(params.getAll("refs"), ["main", "origin/main"]);
    assert.deepEqual(params.getAll("authors"), ["Tuan Pham"]);
  });

  it("only spells out a toggle that is off", () => {
    const params = filterQuery(base({ showRemotes: false, showStashes: false }), new URLSearchParams());
    assert.equal(params.get("remotes"), "0");
    assert.equal(params.get("stashes"), "0");
    assert.equal(params.get("tags"), null, "a toggle left on is the route's own default");
  });
});

describe("graphIsTruthful", () => {
  it("holds for a ref selection, which walks whole histories", () => {
    assert.equal(graphIsTruthful(base({ refs: ["main"] })), true);
  });

  it("fails for an author filter, which drops commits from the middle", () => {
    assert.equal(graphIsTruthful(base({ authors: ["Tuan Pham"] })), false);
  });
});

describe("summaries", () => {
  it("names one ref, counts several, and says so when there are none", () => {
    assert.equal(branchSummary(base()), "All branches");
    assert.equal(branchSummary(base({ refs: ["main"] })), "main");
    assert.equal(branchSummary(base({ refs: ["main", "dev", "old"] })), "3 refs");
    assert.equal(authorSummary(base()), "All authors");
    assert.equal(authorSummary(base({ authors: ["Tuan Pham"] })), "Tuan Pham");
    assert.equal(authorSummary(base({ authors: ["A", "B"] })), "2 authors");
  });
});

describe("matchesQuery", () => {
  it("matches a subject anywhere, ignoring case", () => {
    assert.equal(matchesQuery(commit(), "WORKTREES"), true);
    assert.equal(matchesQuery(commit(), "show more"), true);
    assert.equal(matchesQuery(commit(), "rebase"), false);
  });

  it("matches an author", () => {
    assert.equal(matchesQuery(commit(), "tuan"), true);
  });

  it("matches a hash by prefix only", () => {
    assert.equal(matchesQuery(commit(), "9f1c"), true);
    assert.equal(matchesQuery(commit(), "9F1C2D3"), true);
    assert.equal(matchesQuery(commit(), "2d3e"), false, "a hash is typed from the front, not searched inside");
  });

  it("matches a ref label", () => {
    assert.equal(matchesQuery(commit({ refs: [{ name: "origin/release-2" }] }), "release"), true);
  });

  it("matches nothing for an empty or blank query", () => {
    assert.equal(matchesQuery(commit(), ""), false);
    assert.equal(matchesQuery(commit(), "   "), false);
  });
});

describe("matchIndexes", () => {
  it("returns the positions of every hit, in order", () => {
    const commits = [
      commit({ hash: "aaa1", subject: "Add the graph" }),
      commit({ hash: "bbb2", subject: "Fix the lanes" }),
      commit({ hash: "ccc3", subject: "Add the filter" }),
    ];
    assert.deepEqual(matchIndexes(commits, "add"), [0, 2]);
    assert.deepEqual(matchIndexes(commits, "bbb"), [1]);
    assert.deepEqual(matchIndexes(commits, ""), []);
  });
});
