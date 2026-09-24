// The spec a cluster leaves behind. Its shape is not ours - it is
// qa-report's, and through it combine_qa_reports.py's - so these cases pin
// the parts the user's tooling actually reads: the tag, the relative image
// paths, and the blocked/fix asymmetry that says "this one was not done".
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { buildSpec, primaryWorktree } from "../qaSpec.mjs";

const NOW = 1_700_000_000_000;

function report(patch: Record<string, unknown> = {}) {
  return {
    status: "pass",
    problem: ["It was wrong."],
    fix: ["Changed the thing."],
    steps: ["Open /cart", "Look"],
    notes: [],
    files: ["assets/cart.js"],
    before: null,
    after: null,
    reportPath: "",
    at: NOW,
    ...patch,
  };
}

function batchWith(states: Record<string, unknown>, keys: string[]) {
  return {
    id: "bat_1",
    name: "Checkout work",
    tickets: Object.fromEntries(keys.map((key) => [key, { key, summary: `${key} summary`, url: `https://j/browse/${key}` }])),
    ticketStates: states,
  } as never;
}

const cluster = (keys: string[], name = "Cart totals") => ({ id: "cls_1", name, keys }) as never;

test("every ticket carries its cluster's name as the tag combine_qa_reports filters on", () => {
  const batch = batchWith({ "CAP-1": { state: "review", qa: report() } }, ["CAP-1"]);
  const spec = buildSpec(batch, cluster(["CAP-1"]));
  assert.equal(spec.tickets[0].tag, "Cart totals");
  assert.equal(spec.slug, "cart-totals");
});

test("evidence sits beside the spec, by a short relative path", () => {
  const batch = batchWith(
    { "CAP-1": { state: "review", qa: report({ before: { ext: "png", at: NOW }, after: { ext: "jpg", at: NOW } }) } },
    ["CAP-1"],
  );
  const spec = buildSpec(batch, cluster(["CAP-1"]));
  const images = spec.tickets[0].evidence.map((e: { image: string }) => e.image);
  assert.deepEqual(images, [path.join("screenshots", "CAP-1-before.png"), path.join("screenshots", "CAP-1-after.jpg")]);
  for (const image of images) {
    assert.equal(path.isAbsolute(image), false, "an absolute path breaks the moment .backups is copied");
    assert.equal(image.includes(".."), false, "and so does one that climbs out of the report's own folder");
  }
  assert.deepEqual(
    spec.tickets[0].evidence.map((e: { label: string }) => e.label),
    ["before", "after"],
  );
});

test("a ticket nobody QA'd is in the report as blocked, saying so", () => {
  const batch = batchWith({ "CAP-1": { state: "review", qa: null, summary: "did the thing" } }, ["CAP-1"]);
  const entry = buildSpec(batch, cluster(["CAP-1"])).tickets[0];
  assert.equal(entry.status, "blocked");
  assert.match(entry.notes.join(" "), /No QA report was filed/);
  assert.equal(entry.fix, undefined, "no fix on a blocked entry - that asymmetry is the signal");
  assert.deepEqual(entry.problem, ["CAP-1 summary"]);
});

test("a blocked report keeps its problem and notes but never grows a fix", () => {
  const batch = batchWith(
    { "CAP-1": { state: "failed", reason: "needs a design decision", qa: report({ status: "blocked", notes: ["no spec"] }) } },
    ["CAP-1"],
  );
  const entry = buildSpec(batch, cluster(["CAP-1"])).tickets[0];
  assert.equal(entry.status, "blocked");
  assert.equal(entry.fix, undefined);
  assert.deepEqual(entry.problem, ["It was wrong."]);
  assert.match(entry.notes.join(" "), /no spec/);
  assert.match(entry.notes.join(" "), /needs a design decision/);
});

test("tickets appear in the cluster's own order, not the document's", () => {
  const batch = batchWith(
    {
      "CAP-2": { state: "review", qa: report() },
      "CAP-1": { state: "review", qa: report() },
    },
    ["CAP-1", "CAP-2"],
  );
  const spec = buildSpec(batch, cluster(["CAP-2", "CAP-1"]));
  assert.deepEqual(spec.tickets.map((t: { id: string }) => t.id), ["CAP-2", "CAP-1"]);
});

test("a pass carries its fix, its steps and the files it touched", () => {
  const batch = batchWith({ "CAP-1": { state: "review", qa: report() } }, ["CAP-1"]);
  const entry = buildSpec(batch, cluster(["CAP-1"])).tickets[0];
  assert.deepEqual(entry.fix, ["Changed the thing."]);
  assert.deepEqual(entry.steps, ["Open /cart", "Look"]);
  assert.deepEqual(entry.files, ["assets/cart.js"]);
  assert.equal(entry.url, "https://j/browse/CAP-1");
});

test("the primary worktree is the first entry, so a linked checkout still writes to the main one", async () => {
  const porcelain = [
    "worktree /repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /repo/.worktrees/cart",
    "HEAD def",
    "branch refs/heads/cart",
    "",
  ].join("\n");
  assert.equal(await primaryWorktree("/repo/.worktrees/cart", async () => porcelain), "/repo");
});

test("a repository git cannot describe falls back to where we were", async () => {
  assert.equal(await primaryWorktree("/repo", async () => ""), "/repo");
});
