// What the agent is handed. The single-ticket brief is pinned because the
// several-ticket one must not change it, and because an agent reading a
// truncated brief is a failure nothing else in the panel would report.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentBrief, buildCombinedBrief } from "./brief.ts";
import type { IssueDetail } from "./types.ts";

function detail(patch: Partial<IssueDetail> = {}): IssueDetail {
  return {
    key: "CAP-123",
    summary: "Fix header alignment",
    description: "The header sits 2px low on Safari.",
    status: "In Review",
    type: "Bug",
    priority: "High",
    labels: ["frontend"],
    comments: [],
    url: "https://acme.atlassian.net/browse/CAP-123",
    ...patch,
  };
}

test("the brief opens with the key and summary", () => {
  assert.match(buildAgentBrief(detail()), /^CAP-123: Fix header alignment\n/);
});

test("every fact the panel shows reaches the agent", () => {
  const brief = buildAgentBrief(detail());
  for (const line of ["Type: Bug", "Status: In Review", "Priority: High", "Labels: frontend"]) {
    assert.ok(brief.includes(line), `missing ${line}`);
  }
  assert.ok(brief.includes("https://acme.atlassian.net/browse/CAP-123"));
});

test("an absent priority leaves out the line rather than saying null", () => {
  const brief = buildAgentBrief(detail({ priority: null, labels: [] }));
  assert.ok(!brief.includes("Priority:"));
  assert.ok(!brief.includes("Labels:"));
  assert.ok(!brief.includes("null"));
});

test("an empty description says so, so the agent does not read on expecting one", () => {
  assert.ok(buildAgentBrief(detail({ description: "" })).includes("## Description\n(none)"));
});

test("comments arrive with their author and date", () => {
  const brief = buildAgentBrief(
    detail({
      comments: [
        { author: "Dana Okafor", created: "2026-08-01T10:00:00.000+0000", body: "Ship behind a flag." },
      ],
    }),
  );
  assert.ok(brief.includes("## Comments (1, oldest first)"));
  assert.ok(brief.includes("### Dana Okafor on 2026-08-01"));
  assert.ok(brief.includes("Ship behind a flag."));
});

// ---- Several tickets in one worktree ----

test("one ticket is byte-identical to the single-ticket brief", () => {
  const one = detail();
  assert.equal(buildCombinedBrief([one]), buildAgentBrief(one));
});

test("the heading names every key before any ticket body", () => {
  const combined = buildCombinedBrief([
    detail({ key: "CAP-1" }),
    detail({ key: "CAP-2" }),
    detail({ key: "CAP-3" }),
  ]);
  const head = combined.split("\n").slice(0, 3).join("\n");
  assert.ok(head.includes("CAP-1"));
  assert.ok(head.includes("CAP-2"));
  assert.ok(head.includes("CAP-3"));
  assert.ok(head.includes("3 Jira tickets"));
});

test("every ticket's full brief is carried, in selection order", () => {
  const combined = buildCombinedBrief([
    detail({ key: "CAP-1", summary: "First" }),
    detail({ key: "CAP-2", summary: "Second" }),
  ]);
  assert.ok(combined.includes("CAP-1: First"));
  assert.ok(combined.includes("CAP-2: Second"));
  assert.ok(combined.indexOf("CAP-1: First") < combined.indexOf("CAP-2: Second"));
});

test("tickets are separated so two descriptions cannot read as one", () => {
  const combined = buildCombinedBrief([detail({ key: "CAP-1" }), detail({ key: "CAP-2" })]);
  assert.ok(combined.includes("\n---\n"));
});

test("no tickets is an empty string, not a heading with nothing under it", () => {
  assert.equal(buildCombinedBrief([]), "");
});

// ---- reviewing a ticket ----

import { buildCodeReviewBrief, buildPreviewQaBrief, buildReviewBriefLine } from "../brief.mjs";

const pr = { url: "https://github.com/o/r/pull/7", number: 7 };
const preview = { url: "https://s.com/?preview_theme_id=9", themeId: "9" };

test("a review agent's launch line sends it to its full brief", () => {
  assert.match(buildReviewBriefLine({ key: "CAP-1", task: "code" }), /code review .* CAP-1\. Run `jira-review brief`/);
  assert.match(buildReviewBriefLine({ key: "CAP-1", task: "qa" }), /visual QA/);
});

test("the code review brief names the pull request, the repo context and the report verb", () => {
  const brief = buildCodeReviewBrief({ detail: detail(), pr, worktreePath: "/repo/.worktrees/review/pr-7" });
  for (const part of ["gh pr diff https://github.com/o/r/pull/7", "/repo/.worktrees/review/pr-7", "jira-review code --verdict", "--finding high:", "Never commit, push", "CAP-123: Fix header alignment"]) {
    assert.ok(brief.includes(part), `missing ${part}`);
  }
});

test("the QA brief names both storefronts, both viewports, the password and every report flag", () => {
  const brief = buildPreviewQaBrief({ detail: detail(), preview, liveOrigin: "https://s.com", pages: ["/products/a"], password: "hunter2" });
  for (const part of ["Preview: https://s.com/?preview_theme_id=9", "Live storefront: https://s.com", "hunter2", "1440", "390", "- /products/a", "jira-review-qa", "--before-1440", "--after-1440", "--before-390", "--after-390", "--shot", "--checked", "--wrong", "--note"]) {
    assert.ok(brief.includes(part), `missing ${part}`);
  }
  assert.match(buildPreviewQaBrief({ detail: detail(), preview, liveOrigin: "", pages: [] }), /none stored.*blocked/s);
});
