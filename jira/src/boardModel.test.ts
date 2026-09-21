// The board's column rules, named for what a user would see go wrong.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_BOARD,
  addColumn,
  assignStatus,
  moveColumn,
  parseBoardConfig,
  removeColumn,
  renameColumn,
  resolveColumns,
  serializeBoardConfig,
  setColumnColor,
  setHideUnassigned,
  hidingUnassigned,
  unplacedIssues,
  unassignStatus,
  unassignedStatuses,
  validateBoard,
  type BoardConfig,
} from "./boardModel.ts";
import type { IssueRow } from "./types.ts";

const CATEGORY: Record<string, string> = {
  "To Do": "new",
  Backlog: "new",
  "In Progress": "indeterminate",
  "In Review": "indeterminate",
  Blocked: "indeterminate",
  Done: "done",
};
const categoryOf = (status: string) => CATEGORY[status] ?? null;

function issue(key: string, status: string): IssueRow {
  return {
    key,
    summary: key,
    status,
    statusCategory: CATEGORY[status] ?? null,
    type: "Task",
    assignee: null,
    priority: null,
    updated: null,
    url: "",
  };
}

const BOARD: BoardConfig = {
  columns: [
    { id: "todo", name: "To Do", statuses: ["To Do", "Backlog"] },
    { id: "doing", name: "Doing", statuses: ["In Progress"] },
    { id: "review", name: "Review", statuses: ["In Review"] },
    { id: "done", name: "Done", statuses: ["Done"] },
  ],
};

const names = (columns: { name: string }[]) => columns.map((c) => c.name);

// ---- No configuration ----

test("with nothing configured, each status on the board is its own column, To Do first and Done last", () => {
  const columns = resolveColumns(EMPTY_BOARD, [issue("A-1", "Done"), issue("A-2", "In Progress"), issue("A-3", "To Do")], categoryOf);
  assert.deepEqual(names(columns), ["To Do", "In Progress", "Done"]);
  assert.ok(columns.every((c) => !c.configured));
});

test("statuses of one category are ordered by name", () => {
  const columns = resolveColumns(EMPTY_BOARD, [issue("A-1", "In Review"), issue("A-2", "Blocked")], categoryOf);
  assert.deepEqual(names(columns), ["Blocked", "In Review"]);
});

// ---- Configured columns ----

test("tickets land in the column holding their status", () => {
  const columns = resolveColumns(BOARD, [issue("A-1", "Backlog"), issue("A-2", "In Review")], categoryOf);
  assert.deepEqual(
    columns.find((c) => c.id === "todo")!.issues.map((i) => i.key),
    ["A-1"],
  );
  assert.deepEqual(
    columns.find((c) => c.id === "review")!.issues.map((i) => i.key),
    ["A-2"],
  );
});

test("a configured column shows even when it is empty", () => {
  const columns = resolveColumns(BOARD, [issue("A-1", "To Do")], categoryOf);
  assert.deepEqual(names(columns), ["To Do", "Doing", "Review", "Done"]);
});

test("tickets keep the chosen sort order inside a column", () => {
  const columns = resolveColumns(BOARD, [issue("A-9", "To Do"), issue("A-2", "Backlog"), issue("A-5", "To Do")], categoryOf);
  assert.deepEqual(
    columns[0].issues.map((i) => i.key),
    ["A-9", "A-2", "A-5"],
  );
});

// ---- Leftover statuses ----

test("a status no column claims gets its own column, after all of yours", () => {
  const columns = resolveColumns(BOARD, [issue("A-1", "Blocked")], categoryOf);
  assert.deepEqual(names(columns), ["To Do", "Doing", "Review", "Done", "Blocked"]);
  assert.equal(columns[4].configured, false);
});

test("leftover columns are ordered To Do first, Done last, then by name", () => {
  const board: BoardConfig = { columns: [{ id: "r", name: "Review", statuses: ["In Review"] }] };
  const columns = resolveColumns(board, [issue("A-1", "Done"), issue("A-2", "Blocked"), issue("A-3", "Backlog"), issue("A-4", "In Progress")], categoryOf);
  assert.deepEqual(names(columns), ["Review", "Backlog", "Blocked", "In Progress", "Done"]);
});

test("a leftover column appears only while a ticket has that status", () => {
  const columns = resolveColumns(BOARD, [issue("A-1", "To Do")], categoryOf);
  assert.ok(!names(columns).includes("Blocked"));
});

test("your columns lead even when a leftover's kind comes earlier", () => {
  const board: BoardConfig = { columns: [{ id: "done", name: "Done", statuses: ["Done"] }] };
  assert.deepEqual(names(resolveColumns(board, [issue("A-1", "Backlog")], categoryOf)), ["Done", "Backlog"]);
});

test("a status whose category is unknown goes after every configured column", () => {
  assert.deepEqual(names(resolveColumns(BOARD, [issue("A-1", "Mystery")], categoryOf)).at(-1), "Mystery");
});

// ---- Editing ----

test("giving a status to a second column takes it from the first", () => {
  const next = assignStatus(BOARD, "In Progress", "review");
  assert.deepEqual(next.columns.find((c) => c.id === "doing")!.statuses, []);
  assert.deepEqual(next.columns.find((c) => c.id === "review")!.statuses, ["In Review", "In Progress"]);
});

test("an unnamed column is reported by its position", () => {
  assert.equal(validateBoard(BOARD), null);
  assert.equal(validateBoard(renameColumn(BOARD, "review", "  ")), 2);
});

test("added columns get ids that never collide", () => {
  let board = addColumn(EMPTY_BOARD, "A");
  board = addColumn(board, "B");
  board = removeColumn(board, board.columns[0].id);
  board = addColumn(board, "C");
  assert.equal(new Set(board.columns.map((c) => c.id)).size, board.columns.length);
});

test("moving a column past either end changes nothing", () => {
  assert.deepEqual(moveColumn(BOARD, "todo", -1), BOARD);
  assert.deepEqual(names(moveColumn(BOARD, "todo", 1).columns), ["Doing", "To Do", "Review", "Done"]);
});

test("unassigned statuses are the known ones no column holds", () => {
  const board = unassignStatus(BOARD, "Done");
  assert.deepEqual(unassignedStatuses(board, ["To Do", "Done", "Blocked"]), ["Done", "Blocked"]);
});

// ---- The setting ----

test("a configuration survives a round trip through the setting", () => {
  assert.deepEqual(parseBoardConfig(serializeBoardConfig(BOARD)), BOARD);
});

test("a mangled setting reads as no configuration", () => {
  for (const raw of ["{nope", "[]", 42, "", null, '{"columns": 3}']) assert.deepEqual(parseBoardConfig(raw), EMPTY_BOARD);
});

test("a status saved in two columns keeps only the first", () => {
  const board = parseBoardConfig(
    JSON.stringify({ columns: [{ id: "a", name: "A", statuses: ["Done"] }, { id: "b", name: "B", statuses: ["Done", "X"] }] }),
  );
  assert.deepEqual(board.columns[1].statuses, ["X"]);
});

test("duplicate or missing column ids are repaired on read", () => {
  const board = parseBoardConfig(JSON.stringify({ columns: [{ id: "a", name: "A" }, { id: "a", name: "B" }, { name: "C" }] }));
  assert.equal(new Set(board.columns.map((c) => c.id)).size, 3);
});

// ---- Column colours ----

test("a column colour survives a round trip through the setting", () => {
  const board = setColumnColor(BOARD, "review", "purple");
  const reread = parseBoardConfig(serializeBoardConfig(board));
  assert.equal(reread.columns.find((c) => c.id === "review")!.color, "purple");
});

test("clearing a colour removes it rather than storing null", () => {
  const board = setColumnColor(setColumnColor(BOARD, "todo", "red"), "todo", null);
  assert.ok(!("color" in board.columns[0]));
});

test("a colour outside the palette is dropped on read", () => {
  const board = parseBoardConfig(JSON.stringify({ columns: [{ id: "a", name: "A", color: "url(evil)" }] }));
  assert.equal(board.columns[0].color, undefined);
});

test("a resolved configured column carries its colour", () => {
  const columns = resolveColumns(setColumnColor(BOARD, "doing", "teal"), [issue("A-1", "In Progress")], categoryOf);
  assert.equal(columns.find((c) => c.id === "doing")!.color, "teal");
});

// ---- Hiding unassigned statuses ----

test("hiding unassigned statuses leaves only the configured columns", () => {
  const columns = resolveColumns(setHideUnassigned(BOARD, true), [issue("A-1", "Blocked"), issue("A-2", "To Do")], categoryOf);
  assert.deepEqual(names(columns), ["To Do", "Doing", "Review", "Done"]);
});

test("the hidden tickets are counted, so the board can say what it left out", () => {
  const hidden = unplacedIssues(BOARD, [issue("A-1", "Blocked"), issue("A-2", "To Do"), issue("A-3", "Mystery")]);
  assert.deepEqual(
    hidden.map((i) => i.key),
    ["A-1", "A-3"],
  );
});

test("with no columns configured, hiding has no effect rather than emptying the board", () => {
  const board = setHideUnassigned(EMPTY_BOARD, true);
  assert.equal(hidingUnassigned(board), false);
  assert.deepEqual(names(resolveColumns(board, [issue("A-1", "To Do")], categoryOf)), ["To Do"]);
});

test("the hide option survives a round trip and every column edit", () => {
  let board = setHideUnassigned(BOARD, true);
  board = addColumn(renameColumn(assignStatus(board, "Blocked", "doing"), "doing", "Busy"), "New");
  board = parseBoardConfig(serializeBoardConfig(board));
  assert.equal(board.hideUnassigned, true);
  assert.ok(!("hideUnassigned" in parseBoardConfig(serializeBoardConfig(setHideUnassigned(board, false)))));
});
