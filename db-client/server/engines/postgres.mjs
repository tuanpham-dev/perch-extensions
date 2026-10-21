// PostgreSQL through `pg`. A read-only connection runs each query inside
// BEGIN READ ONLY … ROLLBACK, and refuses statements that would end that
// transaction (see ../sqlText.mjs); the server enforces the rest. Each
// statement is read through a cursor (`pg-cursor`), so at most the row limit
// plus one ever comes over the wire, however many rows the query has.
import pg from "pg";
import Cursor from "pg-cursor";
import { readOnlyViolation, splitStatements, txControlIn } from "../sqlText.mjs";
import { QueryError, ReadOnlyError, connectionMessage, rowsResult, withDeadline } from "./common.mjs";

const TYPES = {
  16: "bool", 17: "bytea", 18: "char", 19: "name", 20: "int8", 21: "int2", 23: "int4", 25: "text", 26: "oid",
  114: "json", 142: "xml", 700: "float4", 701: "float8", 790: "money", 1042: "bpchar", 1043: "varchar",
  1082: "date", 1083: "time", 1114: "timestamp", 1184: "timestamptz", 1186: "interval", 1266: "timetz",
  1700: "numeric", 2950: "uuid", 3802: "jsonb", 1000: "bool[]", 1007: "int4[]", 1009: "text[]", 1016: "int8[]",
};
const typeName = (oid) => TYPES[oid] ?? `oid ${oid}`;
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

export async function connectPostgres(cfg, password) {
  const options = {
    host: cfg.host || "localhost",
    port: Number(cfg.port) || 5432,
    user: cfg.user || undefined,
    password: password ?? undefined,
    database: cfg.database || undefined,
    connectionTimeoutMillis: 10_000,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
    application_name: "Perch DB Client",
  };
  const where = `${options.host}:${options.port}`;
  const client = new pg.Client(options);
  // A dropped connection (server restart, pg_terminate_backend, network)
  // marks this adapter dead; the pool opens a fresh one on the next query.
  let dead = false;
  client.on("error", () => (dead = true));
  client.on("end", () => (dead = true));
  try {
    await client.connect();
  } catch (err) {
    throw new QueryError(connectionMessage(err, where), 502);
  }

  async function cancel() {
    const killer = new pg.Client(options);
    try {
      await killer.connect();
      await killer.query("SELECT pg_cancel_backend($1)", [client.processID]);
    } finally {
      await killer.end().catch(() => {});
    }
  }

  // One statement through a cursor: reads limit + 1 rows (one more than is
  // shown, to tell that there were more), then closes the cursor, which stops
  // the rest on the server. A statement without rows comes back with its
  // command tag and count.
  async function readStatement(sql, limit) {
    const cursor = client.query(new Cursor(sql, null, { rowMode: "array" }));
    // On an error the cursor has already ended itself; closing it again would
    // send a stray Close.
    const rows = await cursor.read(limit + 1);
    await cursor.close();
    const r = cursor._result;
    return { fields: r.fields, rows, command: r.command, rowCount: r.rowCount };
  }

  return {
    engine: "postgres",
    alive: () => !dead,
    async query(text, { limit, timeoutMs, readOnly }) {
      const refused = readOnly ? readOnlyViolation(text, "postgres") : null;
      if (refused) throw new ReadOnlyError(refused);
      // A cursor runs one statement, so a script runs statement by statement.
      // A writable script that doesn't manage its own transaction still runs
      // as one, as it would sent whole: a later error undoes the earlier ones.
      const statements = splitStatements(text, "postgres");
      const wrap = readOnly ? "BEGIN READ ONLY" : statements.length > 1 && !txControlIn(text, "postgres") ? "BEGIN" : null;
      const run = async () => {
        if (wrap) await client.query(wrap);
        const out = [];
        let committed = false;
        try {
          for (const sql of statements) out.push(await readStatement(sql, limit));
          if (wrap === "BEGIN") {
            await client.query("COMMIT");
            committed = true;
          }
        } finally {
          if (wrap && !committed) await client.query("ROLLBACK").catch(() => {});
        }
        return out;
      };
      let results;
      try {
        results = await withDeadline(run(), timeoutMs, cancel);
      } catch (err) {
        if (err?.code === "25006") throw new ReadOnlyError();
        if (err?.code === "57014") throw new QueryError("Cancelled", 409);
        throw err instanceof QueryError ? err : new QueryError(err.message);
      }
      const notes = results
        .filter((r) => !r.fields?.length && r.command)
        .map((r) => `${r.command}${typeof r.rowCount === "number" ? ` ${r.rowCount}` : ""}`);
      const last = [...results].reverse().find((r) => r.fields?.length);
      if (!last) return { kind: "rows", columns: [], rows: [], truncated: false, rowCount: 0, notes };
      const columns = last.fields.map((f) => ({ name: f.name, type: typeName(f.dataTypeID) }));
      return rowsResult(columns, last.rows, limit, notes);
    },
    cancel,
    async schema() {
      const tables = await client.query(
        `SELECT table_schema, table_name, table_type FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2`,
      );
      const cols = await client.query(
        `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position`,
      );
      const bySchema = new Map();
      for (const t of tables.rows) {
        if (!bySchema.has(t.table_schema)) bySchema.set(t.table_schema, new Map());
        bySchema.get(t.table_schema).set(t.table_name, { name: t.table_name, kind: t.table_type === "VIEW" ? "view" : "table", columns: [] });
      }
      for (const c of cols.rows) bySchema.get(c.table_schema)?.get(c.table_name)?.columns.push({ name: c.column_name, type: c.data_type });
      return {
        database: client.database,
        groups: [...bySchema].map(([name, tbls]) => ({ name, kind: "schema", children: [...tbls.values()] })),
      };
    },
    tableQuery(group, table) {
      return `SELECT * FROM ${ident(group)}.${ident(table)} LIMIT 100`;
    },
    async close() {
      await client.end().catch(() => {});
    },
  };
}
