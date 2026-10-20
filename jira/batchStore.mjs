// The batches' durable store, on the host's extension storage (Perch 0.9+,
// activate({ storage })): the document is record "main" in collection
// "batches".
//
// Discipline, all of it load-bearing and all of it agent-tasks' (store.mjs
// there, same reasoning):
//   - the document is held in memory and writes go through one promise chain,
//     so two concurrent update() calls cannot read the same document and have
//     the second silently drop the first's change;
//   - each save is one storage write, durable once it resolves;
//   - onChange sees the document before and after every save, which is where
//     the SSE stream gets "this batch changed" from (batchModel's diffEvents).
//
// No archive record, unlike agent-tasks: an archived batch keeps its
// archivedAt and stays in the document. There is one batch per planning pass,
// not one run per task, so the document does not grow the way that one does.
//
// `storage` is a parameter (the extension passes the host's, tests pass
// scripts/memoryStorage.mjs) so nothing here knows where the data lives.
import { randomBytes } from "node:crypto";
import { emptyDocument, normalizeDocument } from "./batchModel.mjs";

export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

// The batch document's store. Everything below is document-shaped rather
// than batch-shaped, so the review document (reviewStore.mjs) shares it.
//
// options:
//   now       clock, for tests
//   onChange  (before, after) after every successful save
export function createBatchStore(storage, options = {}) {
  return createDocumentStore({ storage, collection: "batches", normalize: normalizeDocument, empty: emptyDocument, ...options });
}

// One document (record "main" of `collection`), with the discipline described
// at the top of this file. `normalize(value, now)` turns whatever is stored
// into a document every model function can be called on; `empty()` is what a
// missing record reads as.
export function createDocumentStore({ storage, collection, normalize, empty, ...options }) {
  const records = storage.collection(collection);
  const now = options.now ?? (() => Date.now());
  const listeners = new Set();
  if (options.onChange) listeners.add(options.onChange);

  let doc = null;
  let queue = Promise.resolve();

  async function ensureLoaded() {
    if (doc) return doc;
    const value = (await records.get("main"))?.value ?? null;
    // The store's own clock, not normalizeDocument's fallback: normalization
    // repairs a started cluster's missing ticket states, and those carry a
    // timestamp. Letting it reach for Date.now() puts a real one into a test
    // that injected a fake clock precisely so it would not have to.
    doc = value === null ? empty() : normalize(value, now());
    return doc;
  }

  function enqueue(task) {
    const run = queue.then(task, task);
    // Keep the chain alive after a rejected task, or one failed update would
    // stop every later one.
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  function notify(before, after) {
    for (const listener of listeners) {
      try {
        listener(before, after);
      } catch (err) {
        console.error("jira: a batch store listener threw:", err);
      }
    }
  }

  return {
    // A snapshot. Callers read it freely; only update() may change anything.
    async get() {
      return enqueue(async () => structuredClone(await ensureLoaded()));
    },

    // `mutator` gets a draft to change in place. It may return a value, which
    // is handed back once the document is safely stored - that is how a
    // route gets the id it just created, or a model function's refusal.
    async update(mutator) {
      return enqueue(async () => {
        const current = await ensureLoaded();
        const before = structuredClone(current);
        const draft = structuredClone(current);
        const result = await mutator(draft);
        await records.put("main", draft);
        doc = draft;
        notify(before, structuredClone(draft));
        return result;
      });
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
