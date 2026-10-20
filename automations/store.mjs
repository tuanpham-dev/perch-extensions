// automations' durable store, on the host's extension storage (Perch 0.9+,
// activate({ storage })): the document is record "main" in collection
// "state". It's held in memory and every change goes through one promise
// chain, so a scheduler tick and a panel edit landing together can never drop
// each other's change. `onChange` hears every save (the server announces it
// to open browsers).
//
// Document: { version: 1, automations: { [id]: entry } }, where an entry is
//   { id, name, enabled, trigger, action, repo,
//     createdAt, updatedAt, lastRunAt, lastResult, lastStatus, nextRunAt, runCount }
import { randomBytes } from "node:crypto";

export function newAutomationId() {
  return `auto_${randomBytes(6).toString("hex")}`;
}

function emptyDocument() {
  return { version: 1, automations: {} };
}

export function createAutomationStore(storage, { onChange } = {}) {
  const state = storage.collection("state");
  let doc = null;
  let queue = Promise.resolve();

  async function ensureLoaded() {
    if (doc) return doc;
    const stored = (await state.get("main"))?.value;
    doc = emptyDocument();
    if (stored?.automations && typeof stored.automations === "object" && !Array.isArray(stored.automations)) {
      doc.automations = stored.automations;
    }
    return doc;
  }

  function enqueue(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }

  return {
    async list() {
      await queue;
      const current = await ensureLoaded();
      return structuredClone(Object.values(current.automations)).sort((a, b) => a.createdAt - b.createdAt);
    },

    async get(id) {
      await queue;
      const current = await ensureLoaded();
      return current.automations[id] ? structuredClone(current.automations[id]) : null;
    },

    // fn(draft) mutates a copy; saved and adopted only if fn does not throw.
    // A tick that changed nothing writes nothing and announces nothing, so an
    // open panel isn't told to refetch every 15 seconds.
    update(fn) {
      return enqueue(async () => {
        const current = await ensureLoaded();
        const draft = structuredClone(current);
        const result = await fn(draft);
        if (JSON.stringify(draft) === JSON.stringify(current)) return result;
        await state.put("main", draft);
        doc = draft;
        onChange?.();
        return result;
      });
    },
  };
}
