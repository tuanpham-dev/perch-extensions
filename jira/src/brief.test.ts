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
