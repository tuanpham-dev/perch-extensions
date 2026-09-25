// What the QA agent is handed: its opening brief and each instruction the
// panel types at it. Pinned because these are the only words that tell the
// agent which ticket, which branch, and what not to do - a truncated or
// reworded one is a failure nothing in the panel would report.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildQaApproveMessage,
  buildQaBriefLine,
  buildQaDropMessage,
  buildQaFixMessage,
  buildQaMergeMessage,
  buildQaRefinePrompt,
  buildQaShipMessage,
  buildHandoffComment,
  buildQaConflictMessage,
} from "../brief.mjs";

const tickets = [
  { key: "LIV-341", summary: "PDP recommendations hover", branch: "cluster/pdp" },
  { key: "LIV-271", summary: "Hydrate banner", branch: "cluster/home" },
];

test("the brief names the batch, both branches, every ticket and its source branch", () => {
  const line = buildQaBriefLine({ batchName: "Sprint 09/05", branch: "qa/sprint-09-05", productionBranch: "main", tickets });
  for (const needle of ["Sprint 09/05", "qa/sprint-09-05", "cut from main", "LIV-341 (cluster/pdp)", "LIV-271 (cluster/home)", "Never push"]) {
    assert.ok(line.includes(needle), `missing: ${needle}`);
  }
  assert.ok(!line.includes("\n"), "it goes on the launch line, so it is one line");
});

test("the brief tells the agent to take the server over and report before waiting", () => {
  const line = buildQaBriefLine({ batchName: "b", branch: "qa/b", productionBranch: "main", tickets });
  assert.match(line, /jira-batch qa-start/);
});

test("a merge names the key, the cluster branch and the verb to answer with", () => {
  const text = buildQaMergeMessage({ key: "LIV-341", summary: "PDP recommendations hover", sourceBranch: "cluster/pdp" });
  assert.match(text, /^Merge LIV-341 - PDP recommendations hover/);
  assert.match(text, /`\[LIV-341\]` on `cluster\/pdp`/);
  assert.match(text, /jira-batch qa-merged LIV-341/);
});

test("a change carries the reviewer's words verbatim and says not to commit", () => {
  const text = buildQaFixMessage({ key: "LIV-341", change: "do not resize the image on hover, now it's smaller" });
  assert.ok(text.includes("do not resize the image on hover, now it's smaller"));
  assert.match(text, /do not commit/);
  assert.match(text, /qa-fixing LIV-341/);
});

test("approval amends, and reports the sha", () => {
  const text = buildQaApproveMessage({ key: "LIV-341" });
  assert.match(text, /amend it into LIV-341's commit/);
  assert.match(text, /qa-approved LIV-341 --commit <sha>/);
});

test("excluding a merged ticket names the commit to drop; a queued one has nothing to drop", () => {
  const merged = buildQaDropMessage({ key: "LIV-318", commit: "abc123", why: "assigned to someone else" });
  assert.match(merged, /Drop its commit abc123/);
  assert.match(merged, /assigned to someone else/);
  const queued = buildQaDropMessage({ key: "LIV-318", commit: "", why: "" });
  assert.match(queued, /never merged, so there is nothing to drop/);
});

test("shipping names both branches, requires a rebase if production moved, and forbids the push", () => {
  const text = buildQaShipMessage({ into: "main", branch: "qa/sprint" });
  assert.match(text, /^Ship into main\./);
  assert.match(text, /Rebase qa\/sprint onto main/);
  assert.match(text, /--no-ff/);
  assert.match(text, /Do not push/);
  assert.match(text, /qa-shipped --into main/);
});

// The refining prompt is what stands between a shorthand note and a comment
// posted under the reviewer's name, so the rule that matters is pinned.
test("the refine prompt keeps claims at their original strength and allows a verbatim answer", () => {
  const text = buildQaRefinePrompt({ key: "LIV-271", summary: "Hydrate banner", note: "image is different than in figma (maybe client did it)" });
  assert.ok(text.includes("image is different than in figma (maybe client did it)"));
  assert.match(text, /exactly as strong as it was/);
  assert.match(text, /a possibility stays a possibility/);
  assert.match(text, /AS-WRITTEN/);
});

// ---- The Jira comment ----

test("the hand-off comment carries the URL, then problem, fix and how to QA, then the note", () => {
  const text = buildHandoffComment({
    url: "https://livpur.com/?preview_theme_id=1",
    qa: { problem: ["Subtotal keeps the old value."], fix: ["Recompute on cart:line-item-change."], steps: ["Open /cart at 1440px", "Change a quantity"] },
    note: "The copy text size already matches the Figma design.",
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "Ready for QA on the main theme: https://livpur.com/?preview_theme_id=1");
  assert.ok(text.includes("Problem\n- Subtotal keeps the old value."));
  assert.ok(text.includes("Fix\n- Recompute on cart:line-item-change."));
  assert.ok(text.includes("How to QA\n1. Open /cart at 1440px\n2. Change a quantity"));
  assert.ok(text.endsWith("Notes\nThe copy text size already matches the Figma design."));
});

test("a ticket with no QA report says so rather than posting empty headings", () => {
  const text = buildHandoffComment({ url: "", qa: null, note: "" });
  assert.equal(text, "Ready for QA on the main theme.\n\nNo QA report was filed for this ticket by its agent.");
  assert.ok(!text.includes("Problem"));
});


test("a conflict tells the ticket's own agent what would not apply, where, and what to do", () => {
  const text = buildQaConflictMessage({ key: "LIV-311", summary: "Cart drawer", qaBranch: "qa/sprint", files: ["sections/cart.liquid"], why: "two rules disagree" });
  assert.match(text, /^LIV-311 - Cart drawer would not apply onto the QA branch qa\/sprint\./);
  assert.match(text, /Conflict in: sections\/cart\.liquid/);
  assert.match(text, /two rules disagree/);
  assert.match(text, /jira-batch done LIV-311/);
});
