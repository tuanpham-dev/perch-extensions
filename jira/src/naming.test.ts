// Branch and session naming. Pinned because the start-work form prefills
// from buildBranch and then creates the worktree from whatever is in the
// field - the two have to agree, and a session name that git accepts but
// tmux does not is a failure that only shows up at launch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBranch, sessionNameFor, shortSlug } from "./naming.ts";
import type { IssueRow } from "./types.ts";

function issue(patch: Partial<IssueRow> = {}): IssueRow {
  return {
    key: "CAP-123",
    summary: "Fix header alignment",
    status: "To Do",
    statusCategory: "new",
    type: "Story",
    assignee: null,
    priority: null,
    updated: null,
    url: "https://acme.atlassian.net/browse/CAP-123",
    ...patch,
  };
}

test("the default template gives key-slug", () => {
  assert.equal(buildBranch("{key}-{slug}", issue()), "CAP-123-fix-header-alignment");
});

test("a bug becomes bugfix and anything else becomes feature", () => {
  assert.equal(buildBranch("{type}/{key}", issue({ type: "Bug" })), "bugfix/CAP-123");
  assert.equal(buildBranch("{type}/{key}", issue({ type: "Story" })), "feature/CAP-123");
  assert.equal(buildBranch("{type}/{key}", issue({ type: "bug" })), "bugfix/CAP-123");
});

test("an empty template falls back to key-slug rather than to nothing", () => {
  assert.equal(buildBranch("", issue()), "CAP-123-fix-header-alignment");
  assert.equal(buildBranch("   ", issue()), "CAP-123-fix-header-alignment");
});

test("a template of only separators still yields the key", () => {
  assert.equal(buildBranch("-{nothing}-", issue()), "{nothing}");
});

test("a slug is trimmed to something a branch name can hold", () => {
  const long = shortSlug("A summary that runs on well past any reasonable branch name length");
  assert.ok(long.length <= 40);
  assert.ok(!long.endsWith("-"));
});

test("punctuation and case collapse into a slug", () => {
  assert.equal(shortSlug("Fix: the HEADER (again!)"), "fix-the-header-again");
});

test("a summary with nothing sluggable still names the branch", () => {
  assert.equal(shortSlug("!!!"), "untitled");
});

test("a session name drops the characters a session name cannot hold", () => {
  assert.equal(sessionNameFor("feature/CAP-123"), "feature-CAP-123");
  assert.equal(sessionNameFor("release/1.2.3"), "release-1-2-3");
  assert.equal(sessionNameFor("fix: nav"), "fix-nav");
});

test("a session name has no leading or trailing separator", () => {
  assert.equal(sessionNameFor("/feature/CAP-1/"), "feature-CAP-1");
});
