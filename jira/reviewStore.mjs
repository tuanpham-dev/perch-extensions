// The review document, record "main" in collection "reviews" of the host's
// extension storage: one review per ticket, and the owner/repo -> local path
// answers the user has given. Same serialized updates and change events as
// the batch document.
import { createDocumentStore } from "./batchStore.mjs";
import { emptyDocument, normalizeDocument } from "./reviewModel.mjs";

export function createReviewStore(storage, options = {}) {
  return createDocumentStore({ storage, collection: "reviews", normalize: normalizeDocument, empty: emptyDocument, ...options });
}
