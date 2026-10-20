// An in-memory stand-in for the host's extension storage (Perch's
// server/src/extensionStorage.ts, handed to activate({ storage })), for unit
// tests of the stores built on it. Same behaviour where tests can see it:
// growing revisions, ifRev conflicts, prefix listing in key order,
// all-or-nothing synchronous transactions, update(fn), notify(), and real
// folders for filesDir()/runtimeDir() under a temp directory. Raw SQL isn't
// available here.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export class MemoryStorageConflict extends Error {
  constructor(current) {
    super("the record has changed since it was read");
    this.name = "StorageConflict";
    this.status = 409;
    this.current = current;
  }
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function createMemoryStorage({ root } = {}) {
  const base = root ?? mkdtempSync(path.join(tmpdir(), "memory-storage-"));
  // collection -> Map(key -> { value (JSON text), rev })
  let data = new Map();
  const validators = new Map();
  const events = [];
  const listeners = new Set();

  const emit = (e) => {
    events.push(e);
    for (const cb of listeners) cb(e);
  };

  function table(store, name) {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  }

  function syncCollection(store, name, changes) {
    const t = table(store, name);
    const record = (key) => {
      const r = t.get(key);
      return r ? { value: JSON.parse(r.value), rev: r.rev } : null;
    };
    const checkRev = (current, opts) => {
      if (opts?.ifRev === undefined) return;
      if ((current?.rev ?? 0) !== opts.ifRev) throw new MemoryStorageConflict(current);
    };
    const note = (c) => {
      if (!changes.has(name)) changes.set(name, []);
      changes.get(name).push(c);
    };
    return {
      get: (key) => record(key),
      put(key, value, opts) {
        if (value === undefined) throw new Error("a value is required");
        const current = record(key);
        checkRev(current, opts);
        const rev = (current?.rev ?? 0) + 1;
        t.set(key, { value: JSON.stringify(value), rev });
        note({ key, rev, value: clone(value) });
        return { rev };
      },
      delete(key, opts) {
        const current = record(key);
        checkRev(current, opts);
        if (!current) return;
        t.delete(key);
        note({ key, rev: current.rev + 1, deleted: true });
      },
      list(opts = {}) {
        let keys = [...t.keys()].sort();
        if (opts.prefix) keys = keys.filter((k) => k.startsWith(opts.prefix));
        if (opts.after !== undefined) keys = keys.filter((k) => k > opts.after);
        if (opts.limit !== undefined) keys = keys.slice(0, opts.limit);
        if (opts.keysOnly) return keys.map((key) => ({ key, rev: t.get(key).rev }));
        return keys.map((key) => ({ key, ...record(key) }));
      },
    };
  }

  // Runs fn against a copy and swaps it in only if fn returns normally.
  function transaction(fn) {
    const draft = new Map([...data].map(([k, v]) => [k, new Map(v)]));
    const changes = new Map();
    const result = fn({ collection: (name) => syncCollection(draft, name, changes) });
    if (result && typeof result.then === "function") throw new Error("transaction callbacks must be synchronous");
    data = draft;
    for (const [collection, list] of changes) emit({ type: "change", collection, changes: list });
    return result;
  }

  const run = (fn) =>
    new Promise((resolve, reject) => {
      try {
        resolve(transaction(fn));
      } catch (err) {
        reject(err);
      }
    });

  const storage = {
    collection(name) {
      const one = (fn) => run((tx) => fn(tx.collection(name)));
      return {
        get: (key) => one((c) => c.get(key)),
        put: (key, value, opts) => one((c) => c.put(key, value, opts)),
        delete: (key, opts) => one((c) => c.delete(key, opts)),
        list: (opts) => one((c) => c.list(opts)),
        update: (key, fn) =>
          one((c) => {
            const next = fn(c.get(key)?.value);
            if (next && typeof next.then === "function") throw new Error("update callbacks must be synchronous");
            if (next === undefined) {
              c.delete(key);
              return null;
            }
            return { value: next, rev: c.put(key, next).rev };
          }),
        validate(fn) {
          validators.set(name, fn);
        },
      };
    },
    transaction: (fn) => run(fn),
    sql: {
      exec() {
        throw new Error("SQL isn't available in memory storage");
      },
      prepare() {
        throw new Error("SQL isn't available in memory storage");
      },
    },
    notify(topic, payload) {
      emit({ type: "topic", topic, payload });
    },
    filesDir() {
      const dir = path.join(base, "files");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    runtimeDir() {
      const dir = path.join(base, "x", "self");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    runtimeDirOf(id) {
      return path.join(base, "x", id);
    },
  };

  return {
    storage,
    // For assertions: what was announced, and the validator a browser write would meet.
    events,
    onEvent: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    validate: (collection, key, value) => {
      const fn = validators.get(collection);
      const message = fn ? fn(key, value) : null;
      return typeof message === "string" && message ? message : null;
    },
    root: base,
  };
}
