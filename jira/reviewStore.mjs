// The review document, ~/.config/perch/jira/reviews.json: one review per
// ticket, and the owner/repo -> local path answers the user has given. Same
// atomic writes, serialized updates and change events as the batch document.
import { createDocumentStore } from "./batchStore.mjs";
import { emptyDocument, normalizeDocument } from "./reviewModel.mjs";

export function createReviewStore(configDir, options = {}) {
  return createDocumentStore({ configDir, file: "reviews.json", normalize: normalizeDocument, empty: emptyDocument, ...options });
}
