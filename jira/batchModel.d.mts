// Types for the parts of batchModel.mjs the client uses. The model is plain
// ESM so server.js and the node tests import it directly; the client's
// typecheck resolves "../batchModel.mjs" to this file.
import type { Batch, Proposal } from "./src/batchTypes.ts";

export declare function applyProposal(
  batch: Batch,
  proposal: Proposal,
  options: { addOnly?: boolean; makeId: () => string; now: number },
): { placed: string[]; warnings: string[] };
