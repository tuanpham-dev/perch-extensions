// A ticket's review, pinned: which menu items a ticket's links allow, the
// task states an agent moves through, what a report must carry, and what is
// posted to GitHub and Jira.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildJiraComment,
  buildPrReviewBody,
  closeReview,
  diffEvents,
  effectiveAction,
  emptyDocument,
  enabledActions,
  markTaskFailed,
  markTaskStopped,
  normalizeDocument,
  pageSlug,
  prReviewFlag,
  recordCodeReport,
  recordQaReport,
  rememberRepoPath,
  setPosted,
  startTask,
  tasksFor,
} from "../reviewModel.mjs";
import { createReviewStore } from "../reviewStore.mjs";

const NOW = 1_700_000_000_000;
const pr = { url: "https://github.com/o/r/pull/7", owner: "o", repo: "r", number: 7, author: null, at: null };
const preview = { kind: "preview", url: "https://s.com/?preview_theme_id=1", store: "", themeId: "1", origin: "https://s.com", path: "/", author: null, at: null };

// ---- the menu (A2) ----

test("each menu item is enabled by its own link, and Both needs both", () => {
  assert.deepEqual(enabledActions({ prs: [pr], previews: [] }), { code: true, qa: false, both: false });
  assert.deepEqual(enabledActions({ prs: [], previews: [preview] }), { code: false, qa: true, both: false });
  assert.deepEqual(enabledActions({ prs: [pr], previews: [preview] }), { code: true, qa: true, both: true });
  assert.deepEqual(enabledActions({ prs: [], previews: [] }), { code: false, qa: false, both: false });
});

test("the remembered choice runs when allowed, else the first enabled item", () => {
  const both = { prs: [pr], previews: [preview] };
  assert.equal(effectiveAction(both, "both"), "both");
  assert.equal(effectiveAction(both, "qa"), "qa");
  assert.equal(effectiveAction({ prs: [], previews: [preview] }, "both"), "qa");
  assert.equal(effectiveAction({ prs: [pr], previews: [] }, "qa"), "code");
  assert.equal(effectiveAction(both, "nonsense"), "code");
  assert.equal(effectiveAction({ prs: [], previews: [] }, "code"), null);
  assert.deepEqual(tasksFor("both"), ["code", "qa"]);
});

// ---- states (A4) ----

function started(task: "code" | "qa" = "code") {
  const doc = emptyDocument();
  const result = startTask(doc, "CAP-1", task, { agentId: "a", cwd: "/w", prUrl: pr.url, previewUrl: preview.url, repo: "/repo" }, NOW);
  assert.equal(result.ok, true);
  return doc;
}

test("starting a task records it as running before anything else happens", () => {
  const doc = started();
  const review = doc.reviews["CAP-1"];
  assert.equal(review.tasks.code.state, "running");
  assert.equal(review.tasks.qa, null);
  assert.equal(review.prUrl, pr.url);
  assert.equal(review.repo, "/repo");
});

test("a task already running cannot be started twice", () => {
  const doc = started();
  const again = startTask(doc, "CAP-1", "code", { agentId: "a" }, NOW + 1);
  assert.equal(again.ok, false);
  assert.match(again.error, /already running/);
});

test("run again replaces the previous report but keeps what was posted", () => {
  const doc = started();
  recordCodeReport(doc, "CAP-1", { verdict: "approve", summary: "fine" }, NOW + 1);
  setPosted(doc, "CAP-1", "pr", { url: "https://github.com/o/r/pull/7#pullrequestreview-1" }, NOW + 2);
  startTask(doc, "CAP-1", "code", { agentId: "a" }, NOW + 3);
  assert.equal(doc.reviews["CAP-1"].tasks.code.report, null);
  assert.equal(doc.reviews["CAP-1"].tasks.code.state, "running");
  assert.ok(doc.reviews["CAP-1"].posted.pr);
});

test("an agent that died leaves its task failed with the reason, and stopping one is recorded", () => {
  const doc = started();
  startTask(doc, "CAP-1", "qa", { agentId: "a" }, NOW);
  markTaskFailed(doc, "CAP-1", "code", "its window is gone", NOW + 5);
  markTaskStopped(doc, "CAP-1", "qa", NOW + 6);
  assert.equal(doc.reviews["CAP-1"].tasks.code.state, "failed");
  assert.equal(doc.reviews["CAP-1"].tasks.code.error, "its window is gone");
  assert.equal(doc.reviews["CAP-1"].tasks.qa.state, "stopped");
  // A task that already ended is not overwritten by a late failure.
  assert.deepEqual(markTaskFailed(doc, "CAP-1", "qa", "late", NOW + 7), { ok: true, unchanged: true });
  assert.equal(doc.reviews["CAP-1"].tasks.qa.state, "stopped");
});

test("closing refuses while an agent works, then keeps the reports and forgets the checkout", () => {
  const doc = started();
  doc.reviews["CAP-1"].worktreePath = "/repo/.worktrees/review/pr-7";
  assert.equal(closeReview(doc, "CAP-1", NOW + 1).ok, false);
  recordCodeReport(doc, "CAP-1", { verdict: "comment", summary: "ok" }, NOW + 2);
  assert.equal(closeReview(doc, "CAP-1", NOW + 3).ok, true);
  assert.equal(doc.reviews["CAP-1"].worktreePath, "");
  assert.equal(doc.reviews["CAP-1"].tasks.code.report?.summary, "ok");
});

// ---- reports (A5) ----

test("a code report needs a verdict and a summary, and only lands on a running task", () => {
  const doc = started();
  assert.equal(recordCodeReport(doc, "CAP-1", { verdict: "lgtm", summary: "x" }, NOW).ok, false);
  assert.equal(recordCodeReport(doc, "CAP-1", { verdict: "approve", summary: " " }, NOW).ok, false);
  const ok = recordCodeReport(
    doc,
    "CAP-1",
    { verdict: "request-changes", summary: "Two issues", findings: [{ severity: "high", file: "a.liquid", line: 4, text: "wrong variant" }, { severity: "bogus", text: "nit" }, { text: "" }] },
    NOW + 1,
  );
  assert.deepEqual(ok, { ok: true, verdict: "request-changes", findings: 2 });
  assert.equal(doc.reviews["CAP-1"].tasks.code.report?.findings[1].severity, "low");
  const late = recordCodeReport(doc, "CAP-1", { verdict: "approve", summary: "again" }, NOW + 2);
  assert.equal(late.ok, false);
  assert.match(late.error, /reported, not running/);
});

test("a QA report is refused for a ticket with no QA task, and keeps its pages and shots", () => {
  const doc = started("code");
  assert.match(recordQaReport(doc, "CAP-1", { status: "pass" }, NOW).error ?? "", /no qa task/);
  startTask(doc, "CAP-1", "qa", { agentId: "a" }, NOW);
  assert.equal(recordQaReport(doc, "CAP-1", { status: "great" }, NOW).ok, false);
  const result = recordQaReport(
    doc,
    "CAP-1",
    {
      status: "fail",
      checked: ["/products/pod"],
      wrong: ["Button overlaps price at 390"],
      pages: [{ page: "/products/pod", slug: "products-pod", images: { "before-1440": { ext: "png" }, "after-390": { ext: "jpg" } }, extras: [{ label: "shot-1", caption: "drawer", ext: "png" }] }],
    },
    NOW + 1,
  );
  assert.deepEqual(result, { ok: true, status: "fail", pages: 1 });
  const page = doc.reviews["CAP-1"].tasks.qa.report?.pages[0];
  assert.deepEqual(page?.images["before-1440"], { ext: "png" });
  assert.equal(page?.images["after-1440"], null);
  assert.equal(page?.extras[0].caption, "drawer");
});

test("page slugs are safe filenames and stay unique", () => {
  const taken = new Set(["products-pod"]);
  assert.equal(pageSlug("/"), "home");
  assert.equal(pageSlug("/products/pod?variant=1"), "products-pod");
  assert.equal(pageSlug("/products/pod", taken), "products-pod-2");
  assert.equal(pageSlug("/../../etc/passwd"), "etc-passwd");
});

// ---- posting (A6) ----

test("the PR review lists findings most severe first, with the mapped flag", () => {
  const doc = started();
  recordCodeReport(
    doc,
    "CAP-1",
    { verdict: "request-changes", summary: "Needs work", findings: [{ severity: "low", text: "nit" }, { severity: "high", file: "a.js", line: 3, text: "bug" }] },
    NOW,
  );
  const body = buildPrReviewBody(doc.reviews["CAP-1"]);
  assert.ok(body.startsWith("Needs work"));
  assert.ok(body.indexOf("bug") < body.indexOf("nit"));
  assert.ok(body.includes("`a.js:3`"));
  assert.equal(prReviewFlag("approve"), "--approve");
  assert.equal(prReviewFlag("request-changes"), "--request-changes");
  assert.equal(prReviewFlag("comment"), "--comment");
});

test("the Jira comment carries both verdicts, the links and only the serious findings", () => {
  const doc = started();
  startTask(doc, "CAP-1", "qa", { agentId: "a" }, NOW);
  recordCodeReport(doc, "CAP-1", { verdict: "approve", summary: "Looks right", findings: [{ severity: "medium", text: "slow loop" }, { severity: "low", text: "nit" }] }, NOW);
  recordQaReport(doc, "CAP-1", { status: "pass", checked: ["/"], notes: ["Checked in Safari too"] }, NOW);
  const comment = buildJiraComment(doc.reviews["CAP-1"], "http://perch/#jira");
  assert.match(comment, /^Code review: Approved \(https:\/\/github.com\/o\/r\/pull\/7\)/);
  assert.ok(comment.includes("- medium: slow loop"));
  assert.ok(comment.includes("- and 1 minor"));
  assert.ok(!comment.includes("nit"));
  assert.ok(comment.includes("Visual QA: Pass (https://s.com/?preview_theme_id=1)"));
  assert.ok(comment.endsWith("Screenshots and details: http://perch/#jira"));
});

// ---- document ----

test("a hand-edited document loads what it can and reports changes per ticket", () => {
  const doc = normalizeDocument({ reviews: { "CAP-1": { tasks: { code: { state: "weird" } } }, BAD: 3 }, repoPaths: { "o/r": "/repo", x: 1 } });
  assert.equal(doc.reviews["CAP-1"].tasks.code?.state, "failed");
  assert.equal(doc.reviews.BAD, undefined);
  assert.deepEqual(doc.repoPaths, { "o/r": "/repo" });
  const after = structuredClone(doc);
  after.reviews["CAP-1"].prUrl = "x";
  assert.deepEqual(diffEvents(doc, after), [{ key: "CAP-1" }]);
  assert.equal(rememberRepoPath(doc, "../evil", "/x").ok, false);
});

test("the review store writes reviews.json and reads it back", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jira-review-store-"));
  const store = createReviewStore(dir, { now: () => NOW });
  await store.update((doc: ReturnType<typeof emptyDocument>) => startTask(doc, "CAP-9", "qa", { agentId: "a" }, NOW));
  const onDisk = JSON.parse(await readFile(path.join(dir, "jira", "reviews.json"), "utf8"));
  assert.equal(onDisk.reviews["CAP-9"].tasks.qa.state, "running");
  const fresh = createReviewStore(dir);
  assert.equal((await fresh.get()).reviews["CAP-9"].tasks.qa.state, "running");
});
