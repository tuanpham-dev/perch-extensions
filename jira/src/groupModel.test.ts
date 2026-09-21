import assert from "node:assert/strict";
import { test } from "node:test";
import { displayKeys, groupByProject, projectOf } from "./groupModel.ts";
import type { IssueRow } from "./types.ts";

function row(key: string, project?: { key: string; name: string }): IssueRow {
  return {
    key,
    summary: key,
    status: "To Do",
    statusCategory: "new",
    type: "Task",
    assignee: null,
    priority: null,
    projectKey: project?.key ?? null,
    projectName: project?.name ?? null,
    updated: null,
    url: "",
  };
}

const CAP = { key: "CAP", name: "Capstone" };
const MAW = { key: "MAW", name: "Mobile App Work" };

test("sections appear in the order their first ticket does", () => {
  const groups = groupByProject([row("MAW-1", MAW), row("CAP-9", CAP), row("MAW-2", MAW)]);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["MAW", "CAP"],
  );
});

test("tickets keep their sorted order inside a section", () => {
  const groups = groupByProject([row("MAW-5", MAW), row("CAP-9", CAP), row("MAW-2", MAW)]);
  assert.deepEqual(
    groups[0].issues.map((i) => i.key),
    ["MAW-5", "MAW-2"],
  );
});

test("a section is named after its project", () => {
  assert.equal(groupByProject([row("CAP-1", CAP)])[0].name, "Capstone");
});

test("a row without project fields falls back to its key prefix", () => {
  assert.deepEqual(projectOf(row("LONG_KEY-42")), { key: "LONG_KEY", name: "LONG_KEY" });
});

test("display order skips collapsed sections", () => {
  const groups = groupByProject([row("CAP-1", CAP), row("MAW-1", MAW), row("CAP-2", CAP)]);
  assert.deepEqual(displayKeys(groups, new Set()), ["CAP-1", "CAP-2", "MAW-1"]);
  assert.deepEqual(displayKeys(groups, new Set(["CAP"])), ["MAW-1"]);
});

test("no tickets, no sections", () => {
  assert.deepEqual(groupByProject([]), []);
});
