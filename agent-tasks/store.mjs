// agent-tasks' durable store, on the host's extension storage (Perch 0.9+,
// activate({ storage })): the live document is record "main" in collection
// "state", and runs that finished long ago are record "archive" beside it.
//
// Discipline, all of it load-bearing:
//   - the document is held in memory and every change goes through one
//     promise chain, so two concurrent update() calls cannot read the same
//     document and have the second silently drop the first's change;
//   - a save writes "main" and "archive" in one storage transaction, so a
//     crash can't leave a run in both or in neither;
//   - every save prunes messages to the newest 500 per run and moves runs
//     that are fully terminal and older than `archiveAfterDays` out to the
//     archive (model.mjs decides both);
//   - an update that leaves the document exactly as it was (an idle sweep, a
//     heartbeat for a worker that already finished) writes nothing and tells
//     no listener, so a quiet store stays quiet on disk and in the browser.
//
// `storage` is a parameter (the extension passes the host's; tests pass
// scripts/memoryStorage.mjs) so nothing here knows where the data lives.
import { randomBytes } from "node:crypto";
import { emptyDocument, insertRun, normalizeDocument, pruneMessages, splitArchivable } from "./model.mjs";

export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

function clone(value) {
  return structuredClone(value);
}

// options:
//   archiveAfterDays  number, or a function returning one (read per save, so
//                     a settings change applies without re-creating the store)
//   now               clock, for tests
//   onChange          (before, after) after every successful save
export function createStore(storage, options = {}) {
  const state = storage.collection("state");
  const now = options.now ?? (() => Date.now());
  const listeners = new Set();
  if (options.onChange) listeners.add(options.onChange);

  let doc = null;
  let queue = Promise.resolve();

  async function archiveDays() {
    const value = typeof options.archiveAfterDays === "function" ? await options.archiveAfterDays() : options.archiveAfterDays;
    const days = Number(value);
    return Number.isFinite(days) && days > 0 ? days : 30;
  }

  async function ensureLoaded() {
    if (doc) return doc;
    doc = normalizeDocument((await state.get("main"))?.value ?? null);
    return doc;
  }

  async function readArchive() {
    const value = (await state.get("archive"))?.value ?? null;
    const runs = value && typeof value === "object" && value.runs && typeof value.runs === "object" ? value.runs : {};
    return { version: 1, runs };
  }

  // Serializes `task` behind every earlier write. A failed task rejects its
  // own caller but never poisons the chain for the next one.
  function enqueue(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }

  // Saves the document (and the archive, when given) as one transaction.
  function save(next, archive) {
    return storage.transaction((tx) => {
      const c = tx.collection("state");
      if (archive) c.put("archive", archive);
      c.put("main", next);
    });
  }

  // Prunes and archives `next`, then saves it - unless nothing differs from
  // `before`, in which case it writes nothing and returns false. Comparing the
  // serialized documents is exact for plain JSON: a value put back the way it
  // was counts as unchanged, and a key added or removed always shows.
  async function persist(before, next) {
    pruneMessages(next);
    const archived = splitArchivable(next, now(), await archiveDays());
    let archive = null;
    if (Object.keys(archived).length > 0) {
      archive = await readArchive();
      for (const [runId, entry] of Object.entries(archived)) archive.runs[runId] = { ...entry, archivedAt: now() };
    } else if (JSON.stringify(before) === JSON.stringify(next)) {
      return false;
    }
    await save(next, archive);
    return true;
  }

  function notify(before, after) {
    for (const listener of listeners) {
      try {
        listener(before, after);
      } catch (err) {
        console.error("agent-tasks: store listener threw:", err);
      }
    }
  }

  return {
    // A snapshot of the current document. Callers never get the live object,
    // so nothing can mutate state outside update().
    async get() {
      await queue;
      return clone(await ensureLoaded());
    },

    // fn(draft) mutates a copy of the document and returns any value; the
    // copy is saved and becomes the document only if fn does not throw, and
    // only when it changed something. fn may be async. Resolves with fn's
    // return value.
    update(fn) {
      return enqueue(async () => {
        const before = await ensureLoaded();
        const draft = clone(before);
        const result = await fn(draft);
        if (!(await persist(before, draft))) return result;
        doc = draft;
        notify(before, draft);
        return result;
      });
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    loadArchive() {
      return enqueue(() => readArchive());
    },

    // Drops one archived run for good. Resolves true when it was there.
    deleteArchivedRun(runId) {
      return enqueue(async () => {
        const archive = await readArchive();
        if (!archive.runs[runId]) return false;
        delete archive.runs[runId];
        await state.put("archive", archive);
        return true;
      });
    },

    // Moves one archived run back into the live document. Its activity clock
    // restarts, or the very next save would archive it again.
    restoreRun(runId) {
      return enqueue(async () => {
        const archive = await readArchive();
        const entry = archive.runs[runId];
        if (!entry?.run) return null;
        const before = await ensureLoaded();
        const draft = clone(before);
        const { archivedAt: _archivedAt, ...rest } = entry;
        insertRun(draft, { ...rest, run: { ...rest.run, updatedAt: now(), restoredAt: now() } });
        delete archive.runs[runId];
        await save(draft, archive);
        doc = draft;
        notify(before, draft);
        return draft.runs[runId];
      });
    },

    // Drops every live run, task, dispatch, gate and message. The archive is
    // left alone.
    reset() {
      return enqueue(async () => {
        const before = await ensureLoaded();
        const draft = emptyDocument();
        await save(draft, null);
        doc = draft;
        notify(before, draft);
      });
    },
  };
}
