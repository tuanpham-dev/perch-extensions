// The AGENTS board's rules, one function at a time. Runs under
// `node --test --experimental-strip-types` (see package.json's test script).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  columnIdOf,
  columnsFor,
  defaultBoardState,
  inScope,
  labelOf,
  looksHookless,
  markOf,
  moveInOrder,
  parseBoardState,
  projectsOf,
  pruneOrder,
  relativeTime,
  sortCards,
  summaryOf,
  type BoardAgent,
} from "./boardModel.ts";

function agent(paneId: string, over: Partial<BoardAgent> = {}): BoardAgent {
  return {
    sessionName: `s-${paneId}`,
    windowIndex: 0,
    windowName: "claude",
    command: "claude",
    cwd: "/works/perch",
    paneId,
    agentId: "perch.agents.claude",
    agentLabel: "Claude Code",
    iconUrl: "",
    icon: "sparkle",
    repo: "/works/perch",
    project: "perch",
    branch: "main",
    linked: false,
    state: "idle",
    lastActivityAt: null,
    ...over,
  };
}

describe("markOf / labelOf", () => {
  it("gives an interrupted turn its own mark", () => {
    assert.equal(markOf({ state: "done", interrupted: true }), "interrupted");
    assert.equal(markOf({ state: "done" }), "done");
    assert.equal(markOf({ state: "waiting" }), "waiting");
  });

  it("names the tool a permission prompt is for", () => {
    assert.equal(labelOf({ stateDetail: "permission", toolName: "Bash" }, "waiting"), "Waiting on you - permission: Bash");
    assert.equal(labelOf({ stateDetail: "question" }, "waiting"), "Waiting on you - question");
    assert.equal(labelOf({ toolName: "Edit" }, "working"), "Working - Edit");
    assert.equal(labelOf({}, "interrupted"), "Interrupted");
  });
});

describe("summaryOf", () => {
  it("says why a waiting agent is waiting", () => {
    assert.equal(summaryOf(agent("a", { state: "waiting", stateDetail: "permission", toolName: "Bash" })), "Permission: Bash");
    assert.equal(summaryOf(agent("a", { state: "waiting", stateDetail: "question" })), "Asked you a question");
    assert.equal(summaryOf(agent("a", { state: "waiting" })), "Needs your answer");
  });

  it("puts the tool in flight beside the prompt while working", () => {
    assert.equal(summaryOf(agent("a", { state: "working", toolName: "Edit", prompt: "fix it" })), 'Edit · "fix it"');
    // A done turn's last tool is history, not what it is on.
    assert.equal(summaryOf(agent("a", { state: "done", toolName: "Edit", prompt: "fix it" })), '"fix it"');
  });

  it("falls back to the title's task label, then to nothing", () => {
    assert.equal(summaryOf(agent("a", { state: "working", taskLabel: "Status bar" })), '"Status bar"');
    assert.equal(summaryOf(agent("a")), "");
    assert.equal(summaryOf(agent("a", { state: "done", interrupted: true })), "Interrupted");
  });
});

describe("projectsOf", () => {
  it("counts agents per repository, worktrees folded in", () => {
    const rows = [
      agent("a"),
      agent("b", { cwd: "/works/perch/.worktrees/x", branch: "x", linked: true }),
      agent("c", { repo: "/works/loom", project: "loom" }),
    ];
    assert.deepEqual(projectsOf(rows), [
      { repo: "/works/loom", project: "loom", title: "loom", count: 1 },
      { repo: "/works/perch", project: "perch", title: "perch", count: 2 },
    ]);
  });

  it("tells two repositories with one name apart by their parent folder", () => {
    const rows = [
      agent("a", { repo: "/home/me/work/app", project: "app" }),
      agent("b", { repo: "/home/me/play/app", project: "app" }),
    ];
    assert.deepEqual(
      projectsOf(rows).map((p) => p.title),
      ["app (play)", "app (work)"],
    );
  });
});

describe("inScope", () => {
  const perch = agent("a");
  const loom = agent("b", { repo: "/works/loom", project: "loom" });

  it("keeps everything for all projects", () => {
    assert.ok(inScope(loom, { mode: "all", selected: [], currentRepo: null }));
  });

  it("keeps only the active tab's repository for this project", () => {
    const scope = { mode: "current" as const, selected: [], currentRepo: "/works/perch" };
    assert.ok(inScope(perch, scope));
    assert.ok(!inScope(loom, scope));
    // No project behind the active tab: nothing is in scope, and the board
    // says so rather than silently showing everything.
    assert.ok(!inScope(perch, { mode: "current", selected: [], currentRepo: null }));
  });

  it("keeps the ticked repositories for selected projects", () => {
    const scope = { mode: "selected" as const, selected: ["/works/loom"], currentRepo: "/works/perch" };
    assert.ok(inScope(loom, scope));
    assert.ok(!inScope(perch, scope));
  });
});

describe("columnsFor", () => {
  it("always draws the four status columns, empty ones included", () => {
    const cols = columnsFor([agent("a", { state: "working" })], "status", []);
    assert.deepEqual(
      cols.map((c) => [c.title, c.cards.length]),
      [
        ["Working", 1],
        ["Waiting on you", 0],
        ["Done", 0],
        ["Idle", 0],
      ],
    );
  });

  it("files an interrupted turn under Done", () => {
    const cols = columnsFor([agent("a", { state: "done", interrupted: true })], "status", []);
    assert.equal(cols[2].cards[0].paneId, "a");
  });

  it("draws one column per project, most urgent card first", () => {
    const rows = [
      agent("idle", { state: "idle", lastActivityAt: 50 }),
      agent("wait", { state: "waiting", lastActivityAt: 10 }),
      agent("loom", { repo: "/works/loom", project: "loom" }),
    ];
    const cols = columnsFor(rows, "project", []);
    assert.deepEqual(
      cols.map((c) => c.title),
      ["loom", "perch"],
    );
    assert.deepEqual(
      cols[1].cards.map((c) => c.paneId),
      ["wait", "idle"],
    );
    assert.equal(cols[1].mark, null);
  });

  it("returns no columns for no projects", () => {
    assert.deepEqual(columnsFor([], "project", []), []);
  });

  it("knows which column a card belongs to", () => {
    assert.equal(columnIdOf(agent("a", { state: "waiting" }), "status"), "waiting");
    assert.equal(columnIdOf(agent("a"), "project"), "/works/perch");
  });
});

describe("sortCards", () => {
  it("puts hand-placed cards first, then the most recently active", () => {
    const rows = [agent("old", { lastActivityAt: 1 }), agent("new", { lastActivityAt: 9 }), agent("pinned", { lastActivityAt: 0 })];
    assert.deepEqual(
      sortCards(rows, ["pinned"]).map((c) => c.paneId),
      ["pinned", "new", "old"],
    );
  });

  it("ignores saved ids for windows that no longer exist", () => {
    const rows = [agent("a", { lastActivityAt: 2 }), agent("b", { lastActivityAt: 1 })];
    assert.deepEqual(
      sortCards(rows, ["gone", "b"]).map((c) => c.paneId),
      ["b", "a"],
    );
  });
});

describe("moveInOrder", () => {
  it("moves a card above another and places the whole column", () => {
    assert.deepEqual(moveInOrder([], ["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  });

  it("moves a card to the end", () => {
    assert.deepEqual(moveInOrder([], ["a", "b", "c"], "a", null), ["b", "c", "a"]);
  });

  it("keeps other columns' saved order after this column's", () => {
    assert.deepEqual(moveInOrder(["x", "b", "y"], ["a", "b"], "b", "a"), ["b", "a", "x", "y"]);
  });

  it("does nothing for a card from another column, or a drop on itself", () => {
    assert.deepEqual(moveInOrder(["x"], ["a", "b"], "z", "a"), ["x"]);
    assert.deepEqual(moveInOrder(["x"], ["a", "b"], "a", "a"), ["x"]);
  });
});

describe("pruneOrder", () => {
  it("keeps a missing window through one poll and drops it on the second", () => {
    const first = pruneOrder(["a", "b"], ["a"], {});
    assert.deepEqual(first, { order: ["a", "b"], misses: { b: 1 } });
    const second = pruneOrder(first.order, ["a"], first.misses);
    assert.deepEqual(second, { order: ["a"], misses: {} });
  });

  it("forgives a window that comes back", () => {
    const first = pruneOrder(["a", "b"], ["a"], {});
    assert.deepEqual(pruneOrder(first.order, ["a", "b"], first.misses), { order: ["a", "b"], misses: {} });
  });
});

describe("relativeTime", () => {
  it("steps from seconds to days", () => {
    const now = 10_000_000;
    assert.equal(relativeTime(now - 12_000, now), "12s");
    assert.equal(relativeTime(now - 4 * 60_000, now), "4m");
    assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h");
    assert.equal(relativeTime(now - 72 * 3_600_000, now), "3d");
    assert.equal(relativeTime(null, now), "");
    // A clock a little ahead of ours is "now", not negative time.
    assert.equal(relativeTime(now + 5_000, now), "0s");
  });
});

describe("parseBoardState", () => {
  const defaults = defaultBoardState("current");

  it("takes the configured default scope, or all projects when it is unknown", () => {
    assert.equal(defaults.scope, "current");
    assert.equal(defaultBoardState("nonsense").scope, "all");
  });

  it("restores a saved state", () => {
    const saved = { scope: "selected", selected: ["/works/loom"], groupBy: "project", order: ["a"], hookHintDismissed: true };
    assert.deepEqual(parseBoardState(JSON.stringify(saved), defaults), saved);
  });

  it("falls back to defaults for anything that doesn't parse", () => {
    assert.deepEqual(parseBoardState(null, defaults), defaults);
    assert.deepEqual(parseBoardState("{not json", defaults), defaults);
    assert.deepEqual(parseBoardState("42", defaults), defaults);
  });

  it("falls back field by field for the wrong shapes", () => {
    const state = parseBoardState(JSON.stringify({ scope: "everything", selected: [1], groupBy: "project", order: "a" }), defaults);
    assert.deepEqual(state, { ...defaults, groupBy: "project" });
  });
});

describe("looksHookless", () => {
  it("is true only when no row carries anything a hook reports", () => {
    assert.equal(looksHookless([agent("a"), agent("b", { state: "done" })]), true);
    assert.equal(looksHookless([agent("a"), agent("b", { prompt: "hi" })]), false);
    assert.equal(looksHookless([]), false);
  });
});
