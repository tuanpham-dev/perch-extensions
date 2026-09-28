// The "Add to batch" review's draft: what the preview shows and what Apply sends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyProposal, markRunning, newBatch } from "../batchModel.mjs";
import { draftFrom, draftToProposal, moveInDraft, previewBatch } from "./proposalDraft.ts";

const NOW = 1_700_000_000_000;

function row(key: string) {
  return { key, summary: `${key} summary`, status: "To Do", type: "Task", priority: "Medium", assignee: null, updated: "", url: "" };
}

function running() {
  const batch = newBatch({ id: "b", name: "B", repo: "/r", criteria: "", readCodebase: false, tickets: [row("CAP-1")], now: NOW });
  applyProposal(batch, { clusters: [{ id: null, name: "One", rationale: "", files: [], keys: ["CAP-1"] }], unclustered: [] }, { makeId: () => "c1", now: NOW });
  markRunning(batch, "c1", { worktreePath: "/w", sessionName: "s", windowId: "w1", now: NOW });
  // What "Add to batch" leaves: the new tickets in the batch, unplaced, and
  // the AI's placement waiting.
  for (const key of ["CAP-2", "CAP-3"]) batch.tickets[key] = { key, summary: key, status: "", type: "", priority: null, url: "" };
  batch.unclustered = ["CAP-2", "CAP-3"];
  batch.pendingProposal = {
    clusters: [
      { id: "c1", name: "One", rationale: "", files: [], keys: ["CAP-2"] },
      { id: null, name: "New", rationale: "", files: [], keys: ["CAP-3"] },
    ],
    unclustered: [],
    keys: ["CAP-2", "CAP-3"],
  };
  return batch;
}

test("the preview shows the proposed placement, with the new cards still movable", () => {
  const batch = running();
  const preview = previewBatch(batch as never, draftFrom(batch.pendingProposal) as never);
  assert.deepEqual(preview.clusters.find((c) => c.id === "c1")?.keys, ["CAP-1", "CAP-2"]);
  assert.deepEqual(preview.clusters.find((c) => c.id === "new-1")?.keys, ["CAP-3"]);
  assert.equal(preview.ticketStates["CAP-2"], undefined, "no state, so the card is not frozen");
  assert.deepEqual(batch.clusters[0].keys, ["CAP-1"], "the batch itself is untouched");
});

test("moving a card edits only the draft, and Apply sends it without temporary ids", () => {
  const batch = running();
  let draft = draftFrom(batch.pendingProposal);
  draft = moveInDraft(draft, batch as never, "CAP-2", null);
  draft = moveInDraft(draft, batch as never, "CAP-3", "c1");
  const sent = draftToProposal(draft);
  assert.deepEqual(sent.unclustered, ["CAP-2"]);
  assert.deepEqual(sent.clusters.find((c) => c.id === "c1")?.keys, ["CAP-3"]);
  assert.ok(sent.clusters.every((c) => !("tempId" in c)));
  applyProposal(batch, sent, { addOnly: true, makeId: () => "c2", now: NOW + 1 });
  assert.deepEqual(batch.clusters[0].keys, ["CAP-1", "CAP-3"]);
  assert.ok(batch.unclustered.includes("CAP-2"), "left out as the reviewer chose");
});
