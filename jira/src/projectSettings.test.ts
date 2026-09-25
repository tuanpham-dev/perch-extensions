// Per-project settings: what a project sees, and what editing one does to
// the JSON the setting holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GLOBAL_ONLY,
  isOverridable,
  overridesFor,
  parseProjectSettings,
  removeProjectOverrides,
  setProjectOverride,
  settingsForProject,
} from "../projectSettings.mjs";

const raw = JSON.stringify({
  CAP: { "jira.productionBranch": "main", "jira.qaStatus": "Ready for QA", "jira.startQaOnFirstReview": true },
  shop: { "jira.productionBranch": "release" },
});

test("parseProjectSettings: reads a map keyed by project, upper-casing keys", () => {
  const { projects, malformed } = parseProjectSettings(raw);
  assert.equal(malformed, false);
  assert.deepEqual(Object.keys(projects).sort(), ["CAP", "SHOP"]);
  assert.equal(projects.SHOP["jira.productionBranch"], "release");
  assert.equal(projects.CAP["jira.startQaOnFirstReview"], true);
});

test("parseProjectSettings: empty, malformed and wrong-shaped values", () => {
  assert.deepEqual(parseProjectSettings(""), { projects: {}, malformed: false });
  assert.deepEqual(parseProjectSettings(undefined), { projects: {}, malformed: false });
  assert.equal(parseProjectSettings("{not json").malformed, true);
  assert.equal(parseProjectSettings("[]").malformed, true);
  assert.equal(parseProjectSettings('"CAP"').malformed, true);
  // A block that is not an object is skipped, not fatal.
  const { projects, malformed } = parseProjectSettings('{"CAP": "main", "SHOP": {"jira.qaStatus": "QA"}}');
  assert.equal(malformed, false);
  assert.deepEqual(Object.keys(projects), ["SHOP"]);
});

test("parseProjectSettings: drops what cannot be per-project", () => {
  const { projects } = parseProjectSettings(
    JSON.stringify({
      CAP: { "jira.siteUrl": "https://elsewhere", "jira.projectMap": "{}", "jira.qaStatus": "QA", "other.thing": 1, "jira.qaAssignee": null },
    }),
  );
  assert.deepEqual(projects.CAP, { "jira.qaStatus": "QA" });
  for (const key of GLOBAL_ONLY) assert.equal(isOverridable(key), false, key);
  assert.equal(isOverridable("jira.productionBranch"), true);
  assert.equal(isOverridable("editor.fontSize"), false);
});

test("overridesFor: the project's block, whatever the case of the key", () => {
  assert.deepEqual(overridesFor(raw, "shop"), { "jira.productionBranch": "release" });
  assert.deepEqual(overridesFor(raw, "NOPE"), {});
  assert.deepEqual(overridesFor(raw, null), {});
  assert.deepEqual(overridesFor("{broken", "CAP"), {});
});

test("settingsForProject: overrides win, everything else inherits, the input is untouched", () => {
  const settings = {
    "jira.siteUrl": "https://x.atlassian.net",
    "jira.productionBranch": "develop",
    "jira.qaStatus": "QA",
    "jira.qaAssignee": "Someone",
    "jira.projectSettings": raw,
  };
  const cap = settingsForProject(settings, "CAP");
  assert.equal(cap["jira.productionBranch"], "main");
  assert.equal(cap["jira.qaStatus"], "Ready for QA");
  assert.equal(cap["jira.qaAssignee"], "Someone");
  assert.equal(cap["jira.siteUrl"], "https://x.atlassian.net");
  assert.equal(settings["jira.productionBranch"], "develop");
  // No project, or a project with nothing set: the same object back.
  assert.equal(settingsForProject(settings, null), settings);
  assert.equal(settingsForProject(settings, "NOPE"), settings);
});

test("setProjectOverride: sets, clears, and removes an emptied project", () => {
  let next = setProjectOverride("{}", "cap", "jira.qaStatus", "Ready");
  assert.deepEqual(JSON.parse(next), { CAP: { "jira.qaStatus": "Ready" } });
  next = setProjectOverride(next, "CAP", "jira.startQaOnFirstReview", false);
  assert.deepEqual(JSON.parse(next), { CAP: { "jira.qaStatus": "Ready", "jira.startQaOnFirstReview": false } });
  // An empty string clears rather than pinning "".
  next = setProjectOverride(next, "CAP", "jira.qaStatus", "");
  assert.deepEqual(JSON.parse(next), { CAP: { "jira.startQaOnFirstReview": false } });
  next = setProjectOverride(next, "CAP", "jira.startQaOnFirstReview", undefined);
  assert.deepEqual(JSON.parse(next), {});
});

test("setProjectOverride: refuses a global-only key and a bad project key, keeping what is there", () => {
  const before = setProjectOverride("{}", "CAP", "jira.qaStatus", "Ready");
  assert.deepEqual(JSON.parse(setProjectOverride(before, "CAP", "jira.siteUrl", "https://nope")), JSON.parse(before));
  assert.deepEqual(JSON.parse(setProjectOverride(before, "not a key", "jira.qaStatus", "x")), JSON.parse(before));
});

test("removeProjectOverrides and stable ordering", () => {
  const two = setProjectOverride(setProjectOverride("{}", "SHOP", "jira.qaStatus", "b"), "CAP", "jira.qaStatus", "a");
  assert.deepEqual(Object.keys(JSON.parse(two)), ["CAP", "SHOP"]);
  assert.deepEqual(JSON.parse(removeProjectOverrides(two, "cap")), { SHOP: { "jira.qaStatus": "b" } });
});
