// The "Add to batch" review, edited before anything is applied.
//
// The server keeps the AI's placement as the batch's pending proposal. The
// review shows it laid over the batch, and a card moved there changes only
// this draft - nothing reaches a running agent until Apply sends the edited
// draft. Before this, the proposal was invisible, every new card sat in
// Unclustered, and a drag handed the ticket to a live agent on the spot.
import { applyProposal } from "../batchModel.mjs";
import type { Batch, Proposal, ProposalCluster } from "./batchTypes";

// A proposed cluster that doesn't exist yet needs an id to be dragged onto;
// it gets a temporary one, which is never sent to the server.
export interface DraftCluster extends ProposalCluster {
  tempId?: string;
}

export interface ProposalDraft extends Proposal {
  clusters: DraftCluster[];
}

export function draftFrom(proposal: Proposal): ProposalDraft {
  return {
    ...proposal,
    clusters: proposal.clusters.map((cluster, i) => (cluster.id ? { ...cluster } : { ...cluster, tempId: `new-${i}` })),
    unclustered: [...(proposal.unclustered ?? [])],
  };
}

// The batch as it would look after Apply, for the review to draw. The new
// tickets get no states here even when placed in a running cluster, so their
// cards stay movable.
export function previewBatch(batch: Batch, draft: ProposalDraft): Batch {
  const preview = structuredClone(batch);
  const fresh = new Set(draft.keys ?? []);
  const ids = draft.clusters.filter((cluster) => !cluster.id && cluster.keys.length > 0).map((cluster) => cluster.tempId ?? "");
  applyProposal(preview, draft, { addOnly: true, makeId: () => ids.shift() ?? `new-${Math.random()}`, now: Date.now() });
  for (const key of fresh) delete preview.ticketStates[key];
  preview.pendingProposal = batch.pendingProposal;
  return preview;
}

// One card moved: out of wherever the draft had it, into a cluster (a real
// one, or a proposed one by its temporary id) or into Unclustered.
export function moveInDraft(draft: ProposalDraft, batch: Batch, key: string, clusterId: string | null): ProposalDraft {
  const clusters = draft.clusters.map((cluster) => ({ ...cluster, keys: cluster.keys.filter((k) => k !== key) }));
  const unclustered = draft.unclustered.filter((k) => k !== key);
  if (clusterId === null) {
    unclustered.push(key);
    return { ...draft, clusters, unclustered };
  }
  const target = clusters.find((cluster) => cluster.id === clusterId || cluster.tempId === clusterId);
  if (target) {
    target.keys.push(key);
  } else {
    const existing = batch.clusters.find((cluster) => cluster.id === clusterId);
    if (!existing) return draft;
    clusters.push({ id: existing.id, name: existing.name, rationale: existing.rationale, files: existing.files, keys: [key] });
  }
  return { ...draft, clusters, unclustered };
}

// What Apply sends: the draft without its temporary ids.
export function draftToProposal(draft: ProposalDraft): Proposal {
  return {
    ...draft,
    clusters: draft.clusters.map(({ tempId: _tempId, ...cluster }) => cluster),
  };
}
