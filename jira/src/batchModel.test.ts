// The batch state machine and its store, pinned. Laid out like agent-tasks'
// src/model.test.ts: the subject is the plain .mjs beside server.js, and each
// case names the situation it protects rather than the mapping it asserts.
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  accept,
  addCluster,
  addNote,
  allowedClusterActions,
  applyProposal,
  badgeCount,
  canArchive,
  clusterState,
  diffEvents,
  emptyDocument,
  hookEvent,
  markClosed,
  markFeedbackSent,
  markRunning,
  markStopped,
  moveTicket,
  newBatch,
  normalizeDocument,
  pendingFeedbackCount,
  remainingTickets,
  recordQa,
  removeCluster,
  sendableFeedback,
  specReady,
  setFeedbackDraft,
  ticketCounts,
  ticketReport,
  renameBatch,
  renameCluster,
  startQa,
  markQaAgent,
  qaQueue,
  shipBlockers,
  markQaMerging,
  markQaMerged,
  markQaFixing,
  markQaFixed,
  approveQa,
  excludeFromQa,
  markQaConflict,
  markQaShipped,
  markHandedOff,
  handoffPending,
  qaHookEvent,
  addQaNote,
} from "../batchModel.mjs";
import { createBatchStore } from "../batchStore.mjs";

const NOW = 1_700_000_000_000;

function rows(...keys: string[]) {
  return keys.map((key) => ({ key, summary: `${key} summary`, type: "Task", priority: "Medium", url: `https://j/${key}`, projectKey: key.split("-")[0] }));
}

function batchOf(...keys: string[]) {
  return newBatch({ id: "bat_1", name: "Batch", repo: "/repo", criteria: "by area", readCodebase: false, tickets: rows(...keys), now: NOW });
}

let ids = 0;
const makeId = () => `cls_${++ids}`;

// A batch with one cluster holding `keys`, already launched.
function running(...keys: string[]) {
  const batch = batchOf(...keys);
  applyProposal(batch, { clusters: [{ id: null, name: "One", rationale: "same area", keys }] }, { makeId, now: NOW });
  markRunning(batch, batch.clusters[0].id, {
    worktreePath: "/repo/.worktrees/one",
    sessionName: "one",
    windowId: "win-1",
    agentId: "perch.agents.claude",
    now: NOW,
  });
  return batch;
}

// ---- normalize ----

test("a document that is not an object at all loads as an empty one", () => {
  assert.deepEqual(normalizeDocument(null), emptyDocument());
  assert.deepEqual(normalizeDocument("nonsense"), emptyDocument());
  assert.deepEqual(normalizeDocument([1, 2]), emptyDocument());
});

test("a batch missing half its collections still loads, with the rest defaulted", () => {
  const doc = normalizeDocument({ batches: { b: { name: "Half" } } });
  assert.equal(doc.batches.b.name, "Half");
  assert.deepEqual(doc.batches.b.clusters, []);
  assert.deepEqual(doc.batches.b.unclustered, []);
  assert.equal(doc.batches.b.archivedAt, null);
});

test("a cluster with a state nobody recognises is read as pending, not dropped", () => {
  const doc = normalizeDocument({ batches: { b: { clusters: [{ id: "c", name: "C", state: "exploded" }] } } });
  assert.equal(doc.batches.b.clusters[0].state, "pending");
  assert.equal(doc.batches.b.clusters[0].name, "C");
});

// ---- planning ----

test("a new batch starts with every ticket unclustered", () => {
  const batch = batchOf("CAP-1", "CAP-2");
  assert.deepEqual(batch.unclustered, ["CAP-1", "CAP-2"]);
  assert.deepEqual(batch.clusters, []);
});

test("a proposal creates clusters and leaves what it did not place unclustered", () => {
  const batch = batchOf("CAP-1", "CAP-2", "CAP-3");
  const { warnings } = applyProposal(
    batch,
    { clusters: [{ id: null, name: "Checkout", rationale: "cart", files: ["cart.js"], keys: ["CAP-1", "CAP-2"] }] },
    { makeId, now: NOW },
  );
  assert.equal(batch.clusters.length, 1);
  assert.deepEqual(batch.clusters[0].keys, ["CAP-1", "CAP-2"]);
  assert.deepEqual(batch.clusters[0].files, ["cart.js"]);
  assert.deepEqual(batch.unclustered, ["CAP-3"]);
  assert.deepEqual(warnings, []);
});

test("a key the model invented is dropped, and says so", () => {
  const batch = batchOf("CAP-1");
  const { warnings } = applyProposal(batch, { clusters: [{ id: null, name: "A", keys: ["CAP-1", "CAP-999"] }] }, { makeId, now: NOW });
  assert.deepEqual(batch.clusters[0].keys, ["CAP-1"]);
  assert.match(warnings.join(" "), /CAP-999 is not in this batch/);
});

test("a key listed in two clusters stays in the first one that claimed it", () => {
  const batch = batchOf("CAP-1");
  const { warnings } = applyProposal(
    batch,
    { clusters: [{ id: null, name: "A", keys: ["CAP-1"] }, { id: null, name: "B", keys: ["CAP-1"] }] },
    { makeId, now: NOW },
  );
  assert.deepEqual(batch.clusters[0].keys, ["CAP-1"]);
  assert.deepEqual(batch.clusters[1].keys, []);
  assert.match(warnings.join(" "), /listed twice/);
});

test("re-planning replaces the clusters that never started and leaves the running one alone", () => {
  const batch = running("CAP-1");
  batch.tickets["CAP-2"] = { key: "CAP-2", summary: "two", type: "", priority: "", url: "", projectKey: "CAP" };
  batch.unclustered = ["CAP-2"];
  applyProposal(batch, { clusters: [{ id: null, name: "Planned", keys: ["CAP-2"] }] }, { makeId, now: NOW + 1 });
  const names = batch.clusters.map((c) => c.name);
  assert.deepEqual(names, ["One", "Planned"]);
  assert.deepEqual(batch.clusters[0].keys, ["CAP-1"], "the running cluster keeps its ticket");
});

test("adding tickets never reorders or re-places what a cluster already holds", () => {
  const batch = running("CAP-1", "CAP-2");
  batch.tickets["CAP-3"] = { key: "CAP-3", summary: "three", type: "", priority: "", url: "", projectKey: "CAP" };
  const cluster = batch.clusters[0];
  applyProposal(
    batch,
    { clusters: [{ id: cluster.id, name: "One renamed", keys: ["CAP-2", "CAP-3"] }] },
    { addOnly: true, makeId, now: NOW + 1 },
  );
  assert.deepEqual(cluster.keys, ["CAP-1", "CAP-2", "CAP-3"], "CAP-3 appended, CAP-1/2 untouched");
  assert.equal(cluster.name, "One", "a launched cluster keeps the name it started under");
});

test("adding tickets refuses to move one that is already being worked", () => {
  const batch = running("CAP-1", "CAP-2");
  batch.tickets["CAP-3"] = { key: "CAP-3", summary: "three", type: "", priority: "", url: "", projectKey: "CAP" };
  const { warnings } = applyProposal(
    batch,
    { clusters: [{ id: null, name: "New", keys: ["CAP-1", "CAP-3"] }] },
    { addOnly: true, makeId, now: NOW + 1 },
  );
  assert.match(warnings.join(" "), /CAP-1 is already being worked/);
  assert.deepEqual(batch.clusters[0].keys, ["CAP-1", "CAP-2"]);
  assert.deepEqual(batch.clusters[1].keys, ["CAP-3"]);
});

test("a cluster that has stopped cannot be given more tickets", () => {
  const batch = running("CAP-1");
  batch.tickets["CAP-2"] = { key: "CAP-2", summary: "two", type: "", priority: "", url: "", projectKey: "CAP" };
  const cluster = batch.clusters[0];
  markStopped(batch, cluster.id, "its terminal window is gone", NOW + 1);
  const { warnings } = applyProposal(
    batch,
    { clusters: [{ id: cluster.id, name: "One", keys: ["CAP-2"] }] },
    { addOnly: true, makeId, now: NOW + 2 },
  );
  assert.match(warnings.join(" "), /cannot take more tickets/);
  assert.ok(!cluster.keys.includes("CAP-2"));
  assert.ok(batch.unclustered.includes("CAP-2"));
});

test("a card can be dragged to another cluster while both are still planned", () => {
  const batch = batchOf("CAP-1", "CAP-2");
  applyProposal(
    batch,
    { clusters: [{ id: null, name: "A", keys: ["CAP-1", "CAP-2"] }, { id: null, name: "B", keys: [] }] },
    { makeId, now: NOW },
  );
  const [a, b] = batch.clusters;
  assert.deepEqual(moveTicket(batch, "CAP-1", b.id, 0, NOW + 1), { ok: true });
  assert.deepEqual(a.keys, ["CAP-2"]);
  assert.deepEqual(b.keys, ["CAP-1"]);
});

test("a card dropped onto a running cluster is queued, so its agent can start it", () => {
  const batch = batchOf("CAP-1", "CAP-2");
  applyProposal(batch, { clusters: [{ id: null, name: "One", keys: ["CAP-1"] }] }, { makeId, now: NOW });
  const cluster = batch.clusters[0];
  markRunning(batch, cluster.id, { worktreePath: "/w", sessionName: "one", windowId: "win-1", agentId: "a", now: NOW });
  assert.equal(batch.ticketStates["CAP-2"], undefined, "precondition: unclustered tickets have no state");
  assert.deepEqual(moveTicket(batch, "CAP-2", cluster.id, null, NOW + 1), { ok: true });
  assert.deepEqual(cluster.keys, ["CAP-1", "CAP-2"]);
  assert.equal(batch.ticketStates["CAP-2"].state, "queued");
  assert.equal(batch.ticketStates["CAP-2"].clusterId, cluster.id);
  assert.equal(ticketReport(batch, cluster.id, "CAP-2", "start", { now: NOW + 2 }).ok, true);
});

test("a saved document whose started cluster lists a ticket with no state queues it on load", () => {
  const batch = running("CAP-1", "CAP-2");
  delete batch.ticketStates["CAP-2"];
  const planned = batchOf("CAP-3");
  applyProposal(planned, { clusters: [{ id: null, name: "Later", keys: ["CAP-3"] }] }, { makeId, now: NOW });
  const doc = normalizeDocument({ version: 1, batches: { [batch.id]: batch, planned } }, NOW + 5);
  const repaired = doc.batches[batch.id].ticketStates["CAP-2"];
  assert.equal(repaired.state, "queued");
  assert.equal(repaired.clusterId, batch.clusters[0].id);
  assert.equal(repaired.since, NOW + 5);
  assert.equal(doc.batches[batch.id].ticketStates["CAP-1"].since, NOW, "an existing state is left alone");
  assert.deepEqual(doc.batches.planned.ticketStates, {}, "a cluster still being planned gets its states when it starts");
});

test("a ticket an agent already holds cannot be dragged anywhere", () => {
  const batch = running("CAP-1");
  addCluster(batch, { id: makeId(), name: "Other", now: NOW });
  const other = batch.clusters[1];
  const result = moveTicket(batch, "CAP-1", other.id, 0, NOW + 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /already been handed to an agent/);
});

test("deleting a planned cluster returns its tickets instead of losing them", () => {
  const batch = batchOf("CAP-1");
  applyProposal(batch, { clusters: [{ id: null, name: "A", keys: ["CAP-1"] }] }, { makeId, now: NOW });
  assert.deepEqual(removeCluster(batch, batch.clusters[0].id, NOW + 1), { ok: true });
  assert.deepEqual(batch.clusters, []);
  assert.deepEqual(batch.unclustered, ["CAP-1"]);
});

test("a cluster that has started cannot be deleted from the review", () => {
  const batch = running("CAP-1");
  const result = removeCluster(batch, batch.clusters[0].id, NOW + 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /already started/);
});

// ---- starting ----

test("launching a cluster gives every one of its tickets a state and empties unclustered", () => {
  const batch = running("CAP-1", "CAP-2");
  assert.equal(batch.ticketStates["CAP-1"].state, "queued");
  assert.equal(batch.ticketStates["CAP-2"].clusterId, batch.clusters[0].id);
  assert.deepEqual(batch.unclustered, []);
  assert.equal(batch.clusters[0].windowId, "win-1");
});

// ---- reports from the worker ----

test("start moves a queued ticket to in progress", () => {
  const batch = running("CAP-1");
  const result = ticketReport(batch, batch.clusters[0].id, "CAP-1", "start", { now: NOW + 1 });
  assert.deepEqual(result, { ok: true, state: "in-progress" });
});

test("done moves it on to review, carrying the agent's summary", () => {
  const batch = running("CAP-1");
  const cluster = batch.clusters[0].id;
  ticketReport(batch, cluster, "CAP-1", "start", { now: NOW + 1 });
  ticketReport(batch, cluster, "CAP-1", "done", { summary: "moved the totals", now: NOW + 2 });
  assert.equal(batch.ticketStates["CAP-1"].state, "review");
  assert.equal(batch.ticketStates["CAP-1"].summary, "moved the totals");
});

test("a reworked ticket can be reported done again without starting it first", () => {
  const batch = running("CAP-1");
  const cluster = batch.clusters[0].id;
  ticketReport(batch, cluster, "CAP-1", "start", { now: NOW + 1 });
  ticketReport(batch, cluster, "CAP-1", "done", { summary: "first pass", now: NOW + 2 });
  setFeedbackDraft(batch, "CAP-1", "also the mini-cart", NOW + 3);
  markFeedbackSent(batch, cluster, ["CAP-1"], NOW + 4);
  assert.equal(batch.ticketStates["CAP-1"].state, "rework");
  const result = ticketReport(batch, cluster, "CAP-1", "done", { summary: "second pass", now: NOW + 5 });
  assert.deepEqual(result, { ok: true, state: "review" });
  assert.equal(batch.ticketStates["CAP-1"].feedback.length, 1, "the feedback stays readable afterwards");
});

test("fail records why, and does not block the rest of the cluster", () => {
  const batch = running("CAP-1", "CAP-2");
  const cluster = batch.clusters[0].id;
  ticketReport(batch, cluster, "CAP-1", "start", { now: NOW + 1 });
  ticketReport(batch, cluster, "CAP-1", "fail", { reason: "needs a design decision", now: NOW + 2 });
  assert.equal(batch.ticketStates["CAP-1"].state, "failed");
  assert.equal(batch.ticketStates["CAP-1"].reason, "needs a design decision");
  assert.deepEqual(ticketReport(batch, cluster, "CAP-2", "start", { now: NOW + 3 }), { ok: true, state: "in-progress" });
});

test("a report for a ticket in another cluster is refused, and names what this one holds", () => {
  const batch = running("CAP-1");
  const result = ticketReport(batch, batch.clusters[0].id, "CAP-999", "done", { now: NOW + 1 });
  assert.equal(result.ok, false);
  assert.match(result.error, /CAP-999 is not in this cluster - it holds CAP-1/);
});

test("reporting done twice is refused rather than silently reopening the ticket", () => {
  const batch = running("CAP-1");
  const cluster = batch.clusters[0].id;
  ticketReport(batch, cluster, "CAP-1", "start", { now: NOW + 1 });
  ticketReport(batch, cluster, "CAP-1", "done", { now: NOW + 2 });
  const result = ticketReport(batch, cluster, "CAP-1", "done", { now: NOW + 3 });
  assert.equal(result.ok, false);
  assert.match(result.error, /CAP-1 is review/);
});

test("an agent that announces the ticket it is already on is not treated as an error", () => {
  const batch = running("CAP-1");
  const cluster = batch.clusters[0].id;
  ticketReport(batch, cluster, "CAP-1", "start", { now: NOW + 1 });
  const before = batch.ticketStates["CAP-1"].history.length;
  assert.deepEqual(ticketReport(batch, cluster, "CAP-1", "start", { now: NOW + 2 }), { ok: true, state: "in-progress" });
  assert.equal(batch.ticketStates["CAP-1"].history.length, before, "and does not write a second history row");
});

// ---- hook events ----

test("a permission prompt puts the ticket in flight back on you", () => {
  const batch = running("CAP-1");
  ticketReport(batch, batch.clusters[0].id, "CAP-1", "start", { now: NOW + 1 });
  hookEvent(batch, "win-1", "permission", NOW + 2);
  assert.equal(batch.ticketStates["CAP-1"].state, "needs-you");
  assert.equal(clusterState(batch, batch.clusters[0]), "waiting");
});

test("a turn that ends mid-ticket means the agent stopped to ask you something", () => {
  const batch = running("CAP-1");
  ticketReport(batch, batch.clusters[0].id, "CAP-1", "start", { now: NOW + 1 });
  hookEvent(batch, "win-1", "stop", NOW + 2);
  assert.equal(batch.ticketStates["CAP-1"].state, "needs-you");
});

test("a turn that ends once everything is reported is the agent going quiet, not a wait", () => {
  const batch = running("CAP-1");
  const cluster = batch.clusters[0].id;
  ticketReport(batch, cluster, "CAP-1", "start", { now: NOW + 1 });
  ticketReport(batch, cluster, "CAP-1", "done", { now: NOW + 2 });
  hookEvent(batch, "win-1", "stop", NOW + 3);
  assert.equal(batch.clusters[0].awaiting, null);
  assert.equal(clusterState(batch, batch.clusters[0]), "idle");
});

test("the next turn takes the ticket off your hands again", () => {
  const batch = running("CAP-1");
  ticketReport(batch, batch.clusters[0].id, "CAP-1", "start", { now: NOW + 1 });
  hookEvent(batch, "win-1", "permission", NOW + 2);
  hookEvent(batch, "win-1", "prompt-submit", NOW + 3);
  assert.equal(batch.ticketStates["CAP-1"].state, "in-progress");
  assert.equal(clusterState(batch, batch.clusters[0]), "running");
});

test("a prompt before any ticket started still shows the cluster as waiting on you", () => {
  const batch = running("CAP-1");
  hookEvent(batch, "win-1", "permission", NOW + 1);
  assert.equal(batch.ticketStates["CAP-1"].state, "queued");
  assert.equal(clusterState(batch, batch.clusters[0]), "waiting");
});

test("a worker's own command clears a wait that a hook had set", () => {
  const batch = running("CAP-1");
  hookEvent(batch, "win-1", "permission", NOW + 1);
  addNote(batch, batch.clusters[0].id, "back at it", NOW + 2);
  assert.equal(clusterState(batch, batch.clusters[0]), "running");
});

// ---- losing a worker ----

test("a cluster whose window is gone returns its ticket to the queue", () => {
  const batch = running("CAP-1", "CAP-2");
  const cluster = batch.clusters[0];
  ticketReport(batch, cluster.id, "CAP-1", "start", { now: NOW + 1 });
  markStopped(batch, cluster.id, "its terminal window is gone", NOW + 2);
  assert.equal(cluster.state, "stopped");
  assert.equal(batch.ticketStates["CAP-1"].state, "queued");
  assert.equal(cluster.windowId, "", "and nothing is still keyed to the dead window");
});

test("what a resumed worker is told about is only what is left", () => {
  const batch = running("CAP-1", "CAP-2");
  const cluster = batch.clusters[0];
  ticketReport(batch, cluster.id, "CAP-1", "start", { now: NOW + 1 });
  ticketReport(batch, cluster.id, "CAP-1", "done", { now: NOW + 2 });
  markStopped(batch, cluster.id, "gone", NOW + 3);
  assert.deepEqual(
    remainingTickets(batch, cluster).map((t) => t.key),
    ["CAP-2"],
  );
});

// ---- what a cluster offers ----

test("each cluster state offers exactly the actions that can work", () => {
  const batch = running("CAP-1");
  const cluster = batch.clusters[0];
  assert.deepEqual(allowedClusterActions(batch, cluster), ["open", "stop"]);

  ticketReport(batch, cluster.id, "CAP-1", "start", { now: NOW + 1 });
  ticketReport(batch, cluster.id, "CAP-1", "done", { now: NOW + 2 });
  assert.deepEqual(allowedClusterActions(batch, cluster), ["open", "stop", "close"], "idle");

  markStopped(batch, cluster.id, "gone", NOW + 3);
  assert.deepEqual(allowedClusterActions(batch, cluster), ["resume", "close"]);

  markClosed(batch, cluster.id, NOW + 4);
  assert.deepEqual(allowedClusterActions(batch, cluster), ["remove-worktree"]);
});

test("a cluster that has not started offers only Start", () => {
  const batch = batchOf("CAP-1");
  applyProposal(batch, { clusters: [{ id: null, name: "A", keys: ["CAP-1"] }] }, { makeId, now: NOW });
  assert.deepEqual(allowedClusterActions(batch, batch.clusters[0]), ["start"]);
});

// ---- review ----

test("drafts are grouped per cluster, because each agent gets one message", () => {
  const batch = running("CAP-1", "CAP-2");
  const cluster = batch.clusters[0].id;
  for (const key of ["CAP-1", "CAP-2"]) {
    ticketReport(batch, cluster, key, "start", { now: NOW + 1 });
    ticketReport(batch, cluster, key, "done", { now: NOW + 2 });
  }
  setFeedbackDraft(batch, "CAP-1", "also the mini-cart", NOW + 3);
  setFeedbackDraft(batch, "CAP-2", "  ", NOW + 3);
  const groups = sendableFeedback(batch);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items.map((i) => i.key), ["CAP-1"], "whitespace is not feedback");
  assert.equal(pendingFeedbackCount(batch), 1);
});

test("sending feedback moves the ticket to rework and keeps the text", () => {
  const batch = running("CAP-1");
  const cluster = batch.clusters[0].id;
  ticketReport(batch, cluster, "CAP-1", "start", { now: NOW + 1 });
  ticketReport(batch, cluster, "CAP-1", "done", { now: NOW + 2 });
  setFeedbackDraft(batch, "CAP-1", "fix the header too", NOW + 3);
  markFeedbackSent(batch, cluster, ["CAP-1"], NOW + 4);
  assert.equal(batch.ticketStates["CAP-1"].state, "rework");
  assert.equal(batch.ticketStates["CAP-1"].feedbackDraft, "");
  assert.deepEqual(batch.ticketStates["CAP-1"].feedback, [{ text: "fix the header too", sentAt: NOW + 4 }]);
});

test("accepting is allowed on a reviewed or failed ticket and nothing else", () => {
  const batch = running("CAP-1", "CAP-2");
  const cluster = batch.clusters[0].id;
  ticketReport(batch, cluster, "CAP-1", "start", { now: NOW + 1 });
  assert.equal(accept(batch, "CAP-1", NOW + 2).ok, false);
  ticketReport(batch, cluster, "CAP-1", "done", { now: NOW + 3 });
  assert.deepEqual(accept(batch, "CAP-1", NOW + 4), { ok: true });
  assert.equal(batch.ticketStates["CAP-1"].state, "done");
});

// ---- batch-level ----

test("the badge counts what is back with you, across batches, ignoring archived ones", () => {
  const a = running("CAP-1");
  ticketReport(a, a.clusters[0].id, "CAP-1", "start", { now: NOW + 1 });
  ticketReport(a, a.clusters[0].id, "CAP-1", "done", { now: NOW + 2 });
  const b = running("OPS-1");
  b.id = "bat_2";
  ticketReport(b, b.clusters[0].id, "OPS-1", "start", { now: NOW + 1 });
  hookEvent(b, "win-1", "permission", NOW + 2);
  const doc = { version: 1, batches: { bat_1: a, bat_2: b } };
  assert.equal(badgeCount(doc), 2);
  b.archivedAt = NOW + 9;
  assert.equal(badgeCount(doc), 1);
});

test("a batch can only be archived once nothing is still running", () => {
  const batch = running("CAP-1");
  assert.equal(canArchive(batch), false);
  markClosed(batch, batch.clusters[0].id, NOW + 1);
  assert.equal(canArchive(batch), true);
});

test("ticket counts include the tickets no cluster has started yet", () => {
  const batch = running("CAP-1");
  batch.tickets["CAP-2"] = { key: "CAP-2", summary: "two", type: "", priority: "", url: "", projectKey: "CAP" };
  batch.unclustered = ["CAP-2"];
  const counts = ticketCounts(batch);
  assert.equal(counts.queued, 2);
  assert.equal(counts.review, 0);
});

test("only the batches that actually changed are announced to the board", () => {
  const before = { version: 1, batches: { a: batchOf("CAP-1"), b: batchOf("OPS-1") } };
  const after = { version: 1, batches: { a: structuredClone(before.batches.a), b: structuredClone(before.batches.b) } };
  after.batches.b.name = "Renamed";
  assert.deepEqual(diffEvents(before, after), [{ batchId: "b" }]);
  assert.deepEqual(diffEvents(before, before), []);
});

test("a batch that appears or disappears is an event too", () => {
  const before = { version: 1, batches: {} };
  const after = { version: 1, batches: { a: batchOf("CAP-1") } };
  assert.deepEqual(diffEvents(before, after), [{ batchId: "a" }]);
  assert.deepEqual(diffEvents(after, before), [{ batchId: "a" }]);
});

// ---- the store ----

async function tempStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "jira-batches-"));
  return { dir, store: createBatchStore(dir, { now: () => NOW }) };
}

test("two updates in flight at once both survive", async () => {
  const { store } = await tempStore();
  await store.update((doc) => {
    doc.batches.a = batchOf("CAP-1");
  });
  await Promise.all([
    store.update((doc) => {
      doc.batches.a.name = "First";
    }),
    store.update((doc) => {
      doc.batches.a.criteria = "second";
    }),
  ]);
  const doc = await store.get();
  assert.equal(doc.batches.a.name, "First");
  assert.equal(doc.batches.a.criteria, "second");
});

test("the document is written 0600, so no other user can read a ticket", async () => {
  const { dir, store } = await tempStore();
  await store.update((doc) => {
    doc.batches.a = batchOf("CAP-1");
  });
  const info = await stat(path.join(dir, "jira", "batches.json"));
  assert.equal(info.mode & 0o777, 0o600);
});

test("a corrupt document is kept aside rather than overwritten, and the store still starts", async () => {
  const { dir, store } = await tempStore();
  await mkdir(path.join(dir, "jira"), { recursive: true });
  await writeFile(path.join(dir, "jira", "batches.json"), "{ not json");
  const doc = await store.get();
  assert.deepEqual(doc.batches, {});
  const kept = (await readdir(path.join(dir, "jira"))).filter((name) => name.includes("corrupt"));
  assert.equal(kept.length, 1);
  assert.equal(await readFile(path.join(dir, "jira", kept[0]), "utf8"), "{ not json");
});

test("every save reports which batches changed, so the board is told once", async () => {
  const seen: string[] = [];
  const dir = await mkdtemp(path.join(tmpdir(), "jira-batches-"));
  const store = createBatchStore(dir, {
    now: () => NOW,
    onChange: (before, after) => {
      for (const event of diffEvents(before, after)) seen.push(event.batchId);
    },
  });
  await store.update((doc) => {
    doc.batches.a = batchOf("CAP-1");
  });
  await store.update((doc) => {
    doc.batches.a.name = "Renamed";
  });
  assert.deepEqual(seen, ["a", "a"]);
});

// ---- QA reports ----

test("a report is refused for a ticket this cluster does not hold", () => {
  const batch = running("CAP-1");
  const result = recordQa(batch, batch.clusters[0].id, "CAP-999", { status: "pass" }, NOW + 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /CAP-999 is not in this cluster/);
});

test("a report before the cluster started has nothing to attach to", () => {
  const batch = batchOf("CAP-1");
  applyProposal(batch, { clusters: [{ id: null, name: "A", keys: ["CAP-1"] }] }, { makeId, now: NOW });
  const result = recordQa(batch, batch.clusters[0].id, "CAP-1", { status: "pass" }, NOW + 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /has no state yet/);
});

test("problem, fix and steps take one string or a list, and blanks are dropped", () => {
  const batch = running("CAP-1");
  recordQa(
    batch,
    batch.clusters[0].id,
    "CAP-1",
    { status: "pass", problem: "one thing", fix: ["a", "", "  ", "b"], steps: [] },
    NOW + 1,
  );
  const qa = batch.ticketStates["CAP-1"].qa;
  assert.deepEqual(qa.problem, ["one thing"]);
  assert.deepEqual(qa.fix, ["a", "b"]);
  assert.deepEqual(qa.steps, []);
});

test("a status nobody recognises is kept as unverified rather than refused", () => {
  const batch = running("CAP-1");
  const result = recordQa(batch, batch.clusters[0].id, "CAP-1", { status: "looks-fine" }, NOW + 1);
  assert.deepEqual(result, { ok: true, status: "unverified" });
});

test("re-reporting after rework keeps what the first pass claimed", () => {
  const batch = running("CAP-1");
  const cluster = batch.clusters[0].id;
  recordQa(batch, cluster, "CAP-1", { status: "pass", fix: ["first"] }, NOW + 1);
  recordQa(batch, cluster, "CAP-1", { status: "fail", fix: ["second"] }, NOW + 2);
  const ticket = batch.ticketStates["CAP-1"];
  assert.equal(ticket.qa.status, "fail");
  assert.deepEqual(ticket.qa.fix, ["second"]);
  assert.equal(ticket.qaHistory.length, 1);
  assert.deepEqual(ticket.qaHistory[0].fix, ["first"]);
});

test("filing a report is a sign of life, like any other report", () => {
  const batch = running("CAP-1");
  hookEvent(batch, "win-1", "permission", NOW + 1);
  assert.equal(clusterState(batch, batch.clusters[0]), "waiting");
  recordQa(batch, batch.clusters[0].id, "CAP-1", { status: "pass" }, NOW + 2);
  assert.equal(batch.clusters[0].awaiting, null);
});

test("a cluster's spec is ready only when every ticket has stopped moving", () => {
  const batch = running("CAP-1", "CAP-2");
  const cluster = batch.clusters[0];
  assert.equal(specReady(batch, cluster), false);
  for (const key of ["CAP-1", "CAP-2"]) {
    ticketReport(batch, cluster.id, key, "start", { now: NOW + 1 });
    ticketReport(batch, cluster.id, key, "done", { now: NOW + 2 });
  }
  assert.equal(specReady(batch, cluster), true, "review counts - the agent is finished with it");
  setFeedbackDraft(batch, "CAP-1", "again please", NOW + 3);
  markFeedbackSent(batch, cluster.id, ["CAP-1"], NOW + 4);
  assert.equal(specReady(batch, cluster), false, "rework puts it back in the agent's hands");
});

test("a reloaded document keeps its reports and its cluster's skills", () => {
  const batch = running("CAP-1");
  recordQa(batch, batch.clusters[0].id, "CAP-1", { status: "pass", fix: ["x"] }, NOW + 1);
  batch.clusters[0].skills = { execution: { name: "execute-jira-ticket", dir: "/d", origin: "yours", missing: false, wanted: "" }, qa: null, execFallback: false };
  const reloaded = normalizeDocument(JSON.parse(JSON.stringify({ version: 1, batches: { bat_1: batch } })));
  const back = reloaded.batches.bat_1;
  assert.equal(back.ticketStates["CAP-1"].qa.status, "pass");
  assert.equal(back.clusters[0].skills.execution.name, "execute-jira-ticket");
});

// ---- Renaming the batch ----

test("a batch takes the name it is given, trimmed and capped", () => {
  const batch = newBatch({ id: "bat_1", name: "Cart drawer totals +2", repo: "/r", criteria: "", readCodebase: false, tickets: [], now: NOW });
  assert.equal(renameBatch(batch, "  Checkout work  ", NOW).ok, true);
  assert.equal(batch.name, "Checkout work");
  renameBatch(batch, "x".repeat(200), NOW);
  assert.equal(batch.name.length, 80);
});

test("a blank name is refused rather than leaving a batch with none", () => {
  const batch = newBatch({ id: "bat_1", name: "Keep me", repo: "/r", criteria: "", readCodebase: false, tickets: [], now: NOW });
  const out = renameBatch(batch, "   ", NOW);
  assert.equal(out.ok, false);
  assert.equal(batch.name, "Keep me");
});

test("a cluster takes the name it is given, trimmed and capped", () => {
  const batch = newBatch({ id: "bat_1", name: "b", repo: "/r", criteria: "", readCodebase: false, tickets: ["CAP-1"], now: NOW });
  addCluster(batch, { id: "cls_1", name: "Cluster 1", now: NOW });
  assert.equal(renameCluster(batch, "cls_1", "  Checkout fixes  ", NOW).ok, true);
  assert.equal(batch.clusters[0].name, "Checkout fixes");
  renameCluster(batch, "cls_1", "y".repeat(200), NOW);
  assert.equal(batch.clusters[0].name.length, 60);
});

// Whitespace is blank. Sliced before it was trimmed, "   " survived as a
// truthy name and left the column heading empty on the board.
test("a whitespace-only cluster name keeps the old one", () => {
  const batch = newBatch({ id: "bat_1", name: "b", repo: "/r", criteria: "", readCodebase: false, tickets: ["CAP-1"], now: NOW });
  addCluster(batch, { id: "cls_1", name: "Checkout fixes", now: NOW });
  assert.equal(renameCluster(batch, "cls_1", "   ", NOW).ok, true);
  assert.equal(batch.clusters[0].name, "Checkout fixes");
});

test("renaming a cluster that is not there is an error, not a silent no-op", () => {
  const batch = newBatch({ id: "bat_1", name: "b", repo: "/r", criteria: "", readCodebase: false, tickets: [], now: NOW });
  assert.equal(renameCluster(batch, "cls_nope", "x", NOW).ok, false);
});

// ---- Tickets added to a cluster that is already running ----

// The reported symptom: the brief lists the new tickets, and `jira-batch
// start` refuses them as belonging to a cluster that has not started - about
// the very cluster the agent is running in. A cluster builds its ticket
// states when it starts, so keys added afterwards had none.
test("a ticket added to a running cluster can be started", () => {
  const batch = batchOf("CAP-1", "CAP-2");
  applyProposal(batch, { clusters: [{ id: null, name: "One", keys: ["CAP-1"] }] }, { makeId, now: NOW });
  const clusterId = batch.clusters[0].id;
  markRunning(batch, clusterId, { worktreePath: "/w", sessionName: "one", windowId: "w1", agentId: "a", now: NOW });

  applyProposal(batch, { clusters: [{ id: clusterId, name: "One", keys: ["CAP-2"] }] }, { addOnly: true, makeId, now: NOW });

  assert.ok(batch.clusters[0].keys.includes("CAP-2"), "the brief lists it");
  const out = ticketReport(batch, clusterId, "CAP-2", "start", { now: NOW + 1 });
  assert.equal(out.ok, true, out.ok ? "" : out.error);
  assert.equal(batch.ticketStates["CAP-2"].state, "in-progress");
});

test("a ticket added to a running cluster is queued, not started", () => {
  const batch = batchOf("CAP-1", "CAP-2");
  applyProposal(batch, { clusters: [{ id: null, name: "One", keys: ["CAP-1"] }] }, { makeId, now: NOW });
  const clusterId = batch.clusters[0].id;
  markRunning(batch, clusterId, { worktreePath: "/w", sessionName: "one", windowId: "w1", agentId: "a", now: NOW });
  applyProposal(batch, { clusters: [{ id: clusterId, name: "One", keys: ["CAP-2"] }] }, { addOnly: true, makeId, now: NOW });

  assert.equal(batch.ticketStates["CAP-2"].state, "queued");
  assert.equal(batch.ticketStates["CAP-2"].clusterId, clusterId);
});

// clusterState counts only keys that have a state. Without one, a cluster
// whose original tickets were all finished read as idle while holding work
// nobody could begin - and an idle cluster is one the board offers to close.
test("added tickets keep a running cluster off idle", () => {
  const batch = batchOf("CAP-1", "CAP-2");
  applyProposal(batch, { clusters: [{ id: null, name: "One", keys: ["CAP-1"] }] }, { makeId, now: NOW });
  const clusterId = batch.clusters[0].id;
  markRunning(batch, clusterId, { worktreePath: "/w", sessionName: "one", windowId: "w1", agentId: "a", now: NOW });
  ticketReport(batch, clusterId, "CAP-1", "start", { now: NOW + 1 });
  ticketReport(batch, clusterId, "CAP-1", "done", { summary: "did it", now: NOW + 2 });
  assert.equal(clusterState(batch, batch.clusters[0]), "idle");

  applyProposal(batch, { clusters: [{ id: clusterId, name: "One", keys: ["CAP-2"] }] }, { addOnly: true, makeId, now: NOW + 3 });
  assert.equal(clusterState(batch, batch.clusters[0]), "running");
});

// A cluster still being planned gets its states at markRunning, as it always
// did - creating them early would make an unstarted cluster look startable.
test("a ticket added to a pending cluster stays without a state until it starts", () => {
  const batch = batchOf("CAP-1", "CAP-2");
  applyProposal(batch, { clusters: [{ id: null, name: "One", keys: ["CAP-1"] }] }, { makeId, now: NOW });
  const clusterId = batch.clusters[0].id;
  applyProposal(batch, { clusters: [{ id: clusterId, name: "One", keys: ["CAP-2"] }] }, { addOnly: true, makeId, now: NOW });
  assert.equal(batch.ticketStates["CAP-2"], undefined);
});

// Normalization repairs a started cluster's missing ticket states, and those
// carry a timestamp. The store injects a clock so a test never has to reason
// about the real one; reaching past it to Date.now() puts a real timestamp in
// a document the test believes it pinned.
test("a repair made while loading uses the store's clock, not the wall clock", async () => {
  const { dir, store } = await tempStore();
  await mkdir(path.join(dir, "jira"), { recursive: true });
  await writeFile(
    path.join(dir, "jira", "batches.json"),
    JSON.stringify({
      version: 1,
      batches: {
        bat_1: {
          id: "bat_1",
          name: "Batch",
          repo: "/repo",
          tickets: { "CAP-1": { key: "CAP-1", summary: "one" } },
          clusters: [{ id: "cls_1", name: "One", state: "running", keys: ["CAP-1"] }],
          ticketStates: {},
          unclustered: [],
        },
      },
    }),
  );
  const doc = await store.get();
  const repaired = doc.batches.bat_1.ticketStates["CAP-1"];
  assert.equal(repaired.state, "queued");
  assert.equal(repaired.since, NOW);
  assert.deepEqual(repaired.history, [{ state: "queued", at: NOW, note: "" }]);
});


// ---- The QA branch ----

// A batch with one running cluster whose tickets are all reviewed, which is
// the state a QA run starts from.
function reviewed(...keys: string[]) {
  const batch = running(...keys);
  const clusterId = batch.clusters[0].id;
  for (const key of keys) {
    ticketReport(batch, clusterId, key, "start", { now: NOW + 1 });
    ticketReport(batch, clusterId, key, "done", { summary: `did ${key}`, now: NOW + 2 });
  }
  return batch;
}

function withPriority(batch: ReturnType<typeof reviewed>, priorities: Record<string, string>) {
  for (const [key, priority] of Object.entries(priorities)) batch.tickets[key].priority = priority;
  return batch;
}

function qaStarted(...keys: string[]) {
  const batch = reviewed(...keys);
  startQa(batch, { branch: "qa/batch", productionBranch: "main", worktreePath: "/repo/.worktrees/qa-batch", now: NOW + 3 });
  markQaAgent(batch, { sessionName: "qa-batch", windowId: "win-qa", now: NOW + 3 });
  return batch;
}

test("a document from before QA branches existed loads with none, and every ticket untouched", () => {
  const batch = running("CAP-1");
  delete (batch as { qa?: unknown }).qa;
  delete (batch.ticketStates["CAP-1"] as { integration?: unknown }).integration;
  const doc = normalizeDocument(JSON.parse(JSON.stringify({ version: 1, batches: { bat_1: batch } })), NOW);
  assert.equal(doc.batches.bat_1.qa, null);
  assert.equal(doc.batches.bat_1.ticketStates["CAP-1"].integration.state, "none");
  const again = normalizeDocument(JSON.parse(JSON.stringify(doc)), NOW + 99);
  assert.deepEqual(again, doc, "normalizing its own output changes nothing");
});

test("the queue is every reviewed, untouched ticket, highest priority first, then by key", () => {
  const batch = withPriority(reviewed("CAP-1", "CAP-2", "CAP-3", "CAP-4"), {
    "CAP-1": "Low",
    "CAP-2": "Highest",
    "CAP-3": "Blocker",
    "CAP-4": "Highest",
  });
  assert.deepEqual(qaQueue(batch), ["CAP-2", "CAP-4", "CAP-1", "CAP-3"], "an unknown priority sorts last, not first");
});

test("QA cannot start with nothing in review, and cannot start twice", () => {
  const empty = running("CAP-1");
  assert.equal(startQa(empty, { branch: "qa/b", productionBranch: "main", worktreePath: "/w", now: NOW }).ok, false);
  const batch = qaStarted("CAP-1");
  const second = startQa(batch, { branch: "qa/b", productionBranch: "main", worktreePath: "/w", now: NOW + 9 });
  assert.equal(second.ok, false);
  assert.match(second.error, /already running/);
});

test("merging takes a ticket out of the queue and into the blockers", () => {
  const batch = qaStarted("CAP-1", "CAP-2");
  assert.equal(markQaMerging(batch, "CAP-1", NOW + 4).ok, true);
  assert.deepEqual(qaQueue(batch), ["CAP-2"]);
  assert.deepEqual(shipBlockers(batch), ["CAP-1"]);
  assert.equal(markQaMerged(batch, "CAP-1", "abc123", NOW + 5).ok, true);
  assert.equal(batch.ticketStates["CAP-1"].integration.state, "merged");
  assert.equal(batch.ticketStates["CAP-1"].integration.commit, "abc123");
});

test("only a reviewed ticket can be merged", () => {
  // CAP-2 is in the cluster but its agent has not reported it: still queued.
  const batch = running("CAP-1", "CAP-2");
  const clusterId = batch.clusters[0].id;
  ticketReport(batch, clusterId, "CAP-1", "start", { now: NOW + 1 });
  ticketReport(batch, clusterId, "CAP-1", "done", { summary: "did it", now: NOW + 2 });
  startQa(batch, { branch: "qa/batch", productionBranch: "main", worktreePath: "/w", now: NOW + 3 });
  assert.equal(batch.ticketStates["CAP-2"].state, "queued");
  const out = markQaMerging(batch, "CAP-2", NOW + 4);
  assert.equal(out.ok, false);
  assert.match(out.error, /queued/);
  assert.deepEqual(qaQueue(batch), ["CAP-1"], "and it is not in the queue either");
});

test("approving marks the ticket done and keeps its commit; a second approval is refused", () => {
  const batch = qaStarted("CAP-1");
  markQaMerging(batch, "CAP-1", NOW + 4);
  markQaMerged(batch, "CAP-1", "abc123", NOW + 5);
  const out = approveQa(batch, "CAP-1", { note: "img is FPO", refinedNote: "The image is a placeholder.", postedNote: "The image is a placeholder." }, NOW + 6);
  assert.equal(out.ok, true);
  const ticket = batch.ticketStates["CAP-1"];
  assert.equal(ticket.state, "done");
  assert.equal(ticket.integration.state, "approved");
  assert.equal(ticket.integration.commit, "abc123");
  assert.equal(ticket.integration.postedNote, "The image is a placeholder.");
  assert.equal(approveQa(batch, "CAP-1", {}, NOW + 7).ok, false);
  assert.deepEqual(shipBlockers(batch), []);
});

test("a change request holds the ticket in fixing, and a second one adds to the first", () => {
  const batch = qaStarted("CAP-1");
  markQaMerging(batch, "CAP-1", NOW + 4);
  markQaMerged(batch, "CAP-1", "abc123", NOW + 5);
  assert.equal(markQaFixing(batch, "CAP-1", "do not resize on hover", NOW + 6).ok, true);
  assert.equal(markQaFixing(batch, "CAP-1", "and close the grey gap", NOW + 7).ok, true);
  assert.equal(batch.ticketStates["CAP-1"].integration.change, "do not resize on hover\nand close the grey gap");
  // The agent's report of what it did is its own field; the reviewer's words
  // are never touched by it.
  markQaFixed(batch, "CAP-1", "hover image no longer resizes", NOW + 8);
  assert.equal(batch.ticketStates["CAP-1"].integration.change, "do not resize on hover\nand close the grey gap");
  assert.equal(batch.ticketStates["CAP-1"].integration.fixed, "hover image no longer resizes");
  markQaFixed(batch, "CAP-1", "", NOW + 8);
  assert.equal(batch.ticketStates["CAP-1"].integration.fixed, "hover image no longer resizes", "an empty report adds nothing");
  assert.deepEqual(shipBlockers(batch), ["CAP-1"], "an uncommitted fix blocks shipping");
  // Approving from fixing is the amend landing; the sha moves, the state stays approved.
  assert.equal(approveQa(batch, "CAP-1", {}, NOW + 9).ok, true);
  assert.equal(markQaMerged(batch, "CAP-1", "def456", NOW + 10).ok, true);
  assert.equal(batch.ticketStates["CAP-1"].integration.state, "approved");
  assert.equal(batch.ticketStates["CAP-1"].integration.commit, "def456");
});

test("excluding removes a ticket from the queue and the blockers, and names the commit to drop when it had one", () => {
  const batch = qaStarted("CAP-1", "CAP-2");
  // Queued: nothing on the branch to drop.
  const queued = excludeFromQa(batch, "CAP-2", "assigned to someone else", NOW + 4);
  assert.equal(queued.ok, true);
  assert.equal(queued.dropCommit, "");
  assert.deepEqual(qaQueue(batch), ["CAP-1"]);
  // Merged: the record says which commit has to go.
  markQaMerging(batch, "CAP-1", NOW + 5);
  markQaMerged(batch, "CAP-1", "abc123", NOW + 6);
  const merged = excludeFromQa(batch, "CAP-1", "out of scope", NOW + 7);
  assert.equal(merged.dropCommit, "abc123");
  assert.deepEqual(shipBlockers(batch), []);
  assert.deepEqual(qaQueue(batch), []);
  // Wanted back: it merges again as a fresh pick.
  assert.equal(markQaMerging(batch, "CAP-1", NOW + 8).ok, true);
  assert.equal(batch.ticketStates["CAP-1"].integration.commit, "", "the old sha does not survive a re-pick");
});

test("an approved ticket cannot be excluded", () => {
  const batch = qaStarted("CAP-1");
  markQaMerging(batch, "CAP-1", NOW + 4);
  markQaMerged(batch, "CAP-1", "abc", NOW + 5);
  approveQa(batch, "CAP-1", {}, NOW + 6);
  assert.equal(excludeFromQa(batch, "CAP-1", "changed my mind", NOW + 7).ok, false);
});

test("a conflict blocks shipping and names its files", () => {
  const batch = qaStarted("CAP-1");
  markQaMerging(batch, "CAP-1", NOW + 4);
  assert.equal(markQaConflict(batch, "CAP-1", { files: ["sections/cart.liquid"], why: "two rules disagree" }, NOW + 5).ok, true);
  assert.deepEqual(shipBlockers(batch), ["CAP-1"]);
  assert.deepEqual(batch.ticketStates["CAP-1"].integration.files, ["sections/cart.liquid"]);
  // A conflicted ticket may be picked again once the agent has sorted it.
  assert.equal(markQaMerging(batch, "CAP-1", NOW + 6).ok, true);
});

test("shipping is refused while anything is merged but unapproved, naming the tickets", () => {
  const batch = qaStarted("CAP-1", "CAP-2", "CAP-3");
  markQaMerging(batch, "CAP-1", NOW + 4);
  markQaMerged(batch, "CAP-1", "a", NOW + 5);
  approveQa(batch, "CAP-1", {}, NOW + 6);
  markQaMerging(batch, "CAP-2", NOW + 7);
  markQaMerged(batch, "CAP-2", "b", NOW + 8);
  excludeFromQa(batch, "CAP-3", "later", NOW + 9);
  const refused = markQaShipped(batch, "main", NOW + 10);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /CAP-2/);
  assert.doesNotMatch(refused.error, /CAP-3/, "an excluded ticket blocks nothing");
  approveQa(batch, "CAP-2", {}, NOW + 11);
  assert.equal(markQaShipped(batch, "main", NOW + 12).ok, true);
  assert.equal(batch.qa!.state, "shipped");
  assert.equal(batch.qa!.shippedInto, "main");
});

test("the hand-off is owed to every approved ticket, then only to the ones that failed", () => {
  const batch = qaStarted("CAP-1", "CAP-2", "CAP-3");
  for (const key of ["CAP-1", "CAP-2"]) {
    markQaMerging(batch, key, NOW + 4);
    markQaMerged(batch, key, key, NOW + 5);
    approveQa(batch, key, {}, NOW + 6);
  }
  excludeFromQa(batch, "CAP-3", "not mine", NOW + 7);
  assert.deepEqual(handoffPending(batch), ["CAP-1", "CAP-2"]);
  markHandedOff(batch, "CAP-1", { url: "https://x/p", ok: true }, NOW + 8);
  markHandedOff(batch, "CAP-2", { url: "https://x/p", ok: false, error: "no transition to QA" }, NOW + 8);
  assert.deepEqual(handoffPending(batch), ["CAP-2"], "a success is never retried");
});

test("the QA agent's own window sets and clears awaiting, and a cluster's window does not touch it", () => {
  const batch = qaStarted("CAP-1");
  markQaMerging(batch, "CAP-1", NOW + 4);
  assert.equal(qaHookEvent(batch, "win-qa", "permission", NOW + 5).ok, true);
  assert.equal(batch.qa!.awaiting, "waiting on a permission prompt");
  assert.equal(qaHookEvent(batch, "win-qa", "prompt-submit", NOW + 6).ok, true);
  assert.equal(batch.qa!.awaiting, null);
  // A stop with work outstanding is a wait; with nothing outstanding it is just quiet.
  qaHookEvent(batch, "win-qa", "stop", NOW + 7);
  assert.equal(batch.qa!.awaiting, "the turn ended without a report");
  assert.equal(qaHookEvent(batch, "win-1", "permission", NOW + 8).ok, false, "the cluster's window is not ours");
});


// The first live QA agent refused to ship - rightly - and had no way to say
// so on the board: `note` was a cluster's verb. Its notes live on the run.
test("the QA agent can leave a note, and it clears a wait", () => {
  const batch = qaStarted("CAP-1");
  qaHookEvent(batch, "win-qa", "permission", NOW + 4);
  assert.equal(addQaNote(batch, "Nothing to ship: the branch equals main.", NOW + 5).ok, true);
  assert.equal(batch.qa!.notes.length, 1);
  assert.equal(batch.qa!.awaiting, null);
  assert.equal(addQaNote(running("CAP-9"), "x", NOW).ok, false, "no QA run, no note");
});
