// SQLite through Node's own node:sqlite, run in a child process: its calls
// are synchronous, so in the server a slow query would stall all of Perch,
// and a worker thread can't be stopped mid-query (terminate() waits for the
// SQLite call to return, which a runaway query never does). Cancel and
// timeout kill the child; a fresh one opens on the next query. A read-only
// connection opens the file read-only, so SQLite itself refuses every write.
import { spawn } from "node:child_process";
import { blankLiterals, splitStatements } from "../sqlText.mjs";
import { QueryError, ReadOnlyError, cellValue, withDeadline } from "./common.mjs";

// The worker: one DatabaseSync, one request at a time.
const WORKER_SOURCE = `
const parentPort = { postMessage: (m) => process.send(m), on: (_e, fn) => process.on("message", fn) };
const workerData = { file: process.argv[1], readOnly: process.argv[2] === "1" };
process.on("disconnect", () => process.exit(0));
const fatal = (message) => process.send({ fatal: message }, () => process.exit(1));
// IPC carries JSON: binary as hex, big integers as strings, here.
const plain = (v) => {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v.subarray(0, 256)).toString("hex");
    return String.fromCharCode(92) + "x" + hex + (v.length > 256 ? "…" : "");
  }
  return v;
};
(function main() {
let sqlite;
try { sqlite = process.getBuiltinModule("node:sqlite"); if (!sqlite) throw new Error("missing"); } catch (err) {
  fatal("SQLite needs Node 23.4 or newer (this server runs " + process.version + ")");
  return;
}
${blankLiterals.toString()}
${splitStatements.toString()}
let db;
try {
  db = new sqlite.DatabaseSync(workerData.file, { readOnly: workerData.readOnly, open: true });
} catch (err) {
  fatal(err.message);
  return;
}
parentPort.postMessage({ ready: true });
parentPort.on("message", ({ id, op, sql, limit }) => {
  try {
    if (op === "schema") {
      const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const out = tables.map((t) => ({
        name: t.name,
        kind: t.type,
        columns: db.prepare("SELECT name, type FROM pragma_table_info(?)").all(t.name).map((c) => ({ name: c.name, type: c.type || "" })),
      }));
      parentPort.postMessage({ id, ok: { tables: out } });
      return;
    }
    const notes = [];
    let last = null;
    for (const stmt of splitStatements(sql)) {
      const st = db.prepare(stmt);
      const cols = st.columns();
      if (cols.length) {
        const rows = [];
        for (const row of st.iterate()) {
          rows.push(cols.map((c) => plain(row[c.name])));
          if (rows.length > limit) break;
        }
        last = { columns: cols.map((c) => ({ name: c.name, type: c.type || "" })), rows };
      } else {
        const r = st.run();
        notes.push(r.changes + " rows changed");
      }
    }
    parentPort.postMessage({ id, ok: { last, notes } });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message, code: err.code, errcode: err.errcode });
  }
});
})();
`;

export async function connectSqlite(cfg) {
  const file = String(cfg.file ?? "");
  if (!file) throw new QueryError("Choose a SQLite file");
  // The live worker: its thread, when it's ready, and the requests waiting on
  // it. Replaced wholesale after a cancel, so a late exit from the old one
  // can't touch requests sent to the new one.
  let current = null;
  let seq = 0;

  function start() {
    const w = spawn(process.execPath, ["--input-type=commonjs", "-e", WORKER_SOURCE, file, cfg.writable === true ? "0" : "1"], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { PATH: process.env.PATH ?? "" },
    });
    const pending = new Map();
    let stderr = "";
    w.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    const ready = new Promise((resolve, reject) => {
      w.once("message", (m) => (m.fatal ? reject(new QueryError(m.fatal, 502)) : resolve()));
      w.once("error", (err) => reject(new QueryError(err.message, 502)));
      w.once("exit", () => reject(new QueryError(stderr.trim().split("\n").pop() || "SQLite stopped", 502)));
    });
    ready.catch(() => {});
    w.on("message", (m) => {
      if (m.id === undefined) return;
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) return;
      if (m.error) {
        if (/readonly|read-only/i.test(m.error) || m.errcode === 8) p.reject(new ReadOnlyError());
        else p.reject(new QueryError(m.error));
      } else p.resolve(m.ok);
    });
    w.on("exit", () => {
      for (const p of pending.values()) p.reject(new QueryError("Cancelled", 409));
      pending.clear();
      if (current?.w === w) current = null;
    });
    current = { w, ready, pending };
    return current;
  }

  async function call(message) {
    const c = current ?? start();
    await c.ready;
    const id = ++seq;
    return new Promise((resolve, reject) => {
      c.pending.set(id, { resolve, reject });
      c.w.send({ id, ...message });
    });
  }

  async function cancel() {
    const c = current;
    current = null;
    c?.w.kill("SIGKILL");
  }

  // Opens the file now, so a bad path fails on connect.
  try {
    await call({ op: "schema" });
  } catch (err) {
    await cancel();
    throw err instanceof QueryError ? err : new QueryError(err.message, 502);
  }

  return {
    engine: "sqlite",
    // Read-only is the file handle itself (see above), so `readOnly` needs no
    // handling here; the pool reopens the file when the connection changes.
    async query(text, { limit, timeoutMs }) {
      const out = await withDeadline(call({ op: "query", sql: text, limit }), timeoutMs, cancel);
      if (!out.last) return { kind: "rows", columns: [], rows: [], truncated: false, rowCount: 0, notes: out.notes };
      const { columns, rows } = out.last;
      return {
        kind: "rows",
        columns,
        rows: rows.slice(0, limit).map((r) => r.map(cellValue)),
        truncated: rows.length > limit,
        rowCount: rows.length,
        notes: out.notes,
      };
    },
    cancel,
    async schema() {
      const { tables } = await call({ op: "schema" });
      return { database: file, groups: [{ name: "main", kind: "database", children: tables }] };
    },
    tableQuery(_group, table) {
      return `SELECT * FROM "${String(table).replace(/"/g, '""')}" LIMIT 100`;
    },
    async close() {
      await cancel();
    },
  };
}
