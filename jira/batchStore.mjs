// The batches' durable store: one JSON document at
// <config>/perch/jira/batches.json.
//
// Discipline, all of it load-bearing and all of it agent-tasks' (store.mjs
// there, same reasoning):
//   - every write is temp-then-rename at 0600, so a crash mid-write leaves
//     the previous document, never half of a new one;
//   - writes go through one promise chain, so two concurrent update() calls
//     cannot read the same document and have the second silently drop the
//     first's change;
//   - a missing or corrupt file loads as an empty document rather than
//     failing activation - the corrupt file is kept aside, not overwritten,
//     because a batch holds the only record of what agents are running;
//   - onChange sees the document before and after every save, which is where
//     the SSE stream gets "this batch changed" from (batchModel's diffEvents).
//
// No archive file, unlike agent-tasks: an archived batch keeps its
// archivedAt and stays in the document. There is one batch per planning pass,
// not one run per task, so the document does not grow the way that one does.
//
// The config dir is a parameter (the extension passes the host's, tests pass
// a mkdtemp) so nothing here knows where the real profile lives.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyDocument, normalizeDocument } from "./batchModel.mjs";

export function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

async function readJson(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { value: null, raw: null };
    throw err;
  }
  try {
    return { value: JSON.parse(raw), raw };
  } catch {
    return { value: null, raw };
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  // writeFile's mode is masked by the umask; chmod is not.
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

// The batch document's store. Everything below is document-shaped rather
// than batch-shaped, so the review document (reviewStore.mjs) shares it.
//
// options:
//   now       clock, for tests
//   onChange  (before, after) after every successful save
export function createBatchStore(configDir, options = {}) {
  return createDocumentStore({ configDir, file: "batches.json", normalize: normalizeDocument, empty: emptyDocument, ...options });
}

// One JSON document under <configDir>/jira/, with the discipline described at
// the top of this file. `normalize(value, now)` turns whatever is on disk into
// a document every model function can be called on; `empty()` is what a
// missing file reads as.
export function createDocumentStore({ configDir, file, normalize, empty, ...options }) {
  const dir = path.join(configDir, "jira");
  const storePath = path.join(dir, file);
  const now = options.now ?? (() => Date.now());
  const listeners = new Set();
  if (options.onChange) listeners.add(options.onChange);

  let doc = null;
  let queue = Promise.resolve();

  async function ensureLoaded() {
    if (doc) return doc;
    const { value, raw } = await readJson(storePath);
    if (value === null && raw !== null) {
      // Unparseable. Keeping it costs one file; throwing it away could cost
      // the user the record of which worktrees have agents in them.
      const kept = `${storePath}.corrupt-${now()}`;
      await rename(storePath, kept).catch(() => {});
      console.warn(`jira: ${storePath} was not valid JSON - kept it as ${kept} and started empty`);
    }
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
    path: storePath,

    // A snapshot. Callers read it freely; only update() may change anything.
    async get() {
      return enqueue(async () => structuredClone(await ensureLoaded()));
    },

    // `mutator` gets a draft to change in place. It may return a value, which
    // is handed back once the document is safely on disk - that is how a
    // route gets the id it just created, or a model function's refusal.
    async update(mutator) {
      return enqueue(async () => {
        const current = await ensureLoaded();
        const before = structuredClone(current);
        const draft = structuredClone(current);
        const result = await mutator(draft);
        await writeJsonAtomic(storePath, draft);
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
