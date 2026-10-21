// MySQL and MariaDB through `mysql2`. A read-only connection runs each query
// inside START TRANSACTION READ ONLY … ROLLBACK and refuses statements that
// would end that transaction (see ../sqlText.mjs). Rows are read as they
// stream in and only the row limit plus one is kept: past that a result's
// rows are dropped as they arrive, and when it's the script's last result
// the connection is closed so the server stops sending (the pool opens a
// fresh one on the next query).
import mysql from "mysql2/promise";
import { readOnlyViolation, splitStatements } from "../sqlText.mjs";
import { QueryError, ReadOnlyError, connectionMessage, rowsResult, withDeadline } from "./common.mjs";

const TYPES = {
  0: "decimal", 1: "tinyint", 2: "smallint", 3: "int", 4: "float", 5: "double", 7: "timestamp", 8: "bigint",
  9: "mediumint", 10: "date", 11: "time", 12: "datetime", 13: "year", 15: "varchar", 16: "bit", 245: "json",
  246: "decimal", 247: "enum", 248: "set", 249: "tinyblob", 250: "mediumblob", 251: "longblob", 252: "blob/text",
  253: "varchar", 254: "char", 255: "geometry",
};
const ident = (s) => `\`${String(s).replace(/`/g, "``")}\``;

export async function connectMysql(cfg, password) {
  const options = {
    host: cfg.host || "localhost",
    port: Number(cfg.port) || 3306,
    user: cfg.user || undefined,
    password: password ?? undefined,
    database: cfg.database || undefined,
    multipleStatements: true,
    rowsAsArray: true,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectTimeout: 10_000,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
  };
  const where = `${options.host}:${options.port}`;
  let conn;
  try {
    conn = await mysql.createConnection(options);
  } catch (err) {
    throw new QueryError(connectionMessage(err, where), 502);
  }
  // A dropped connection marks this adapter dead; the pool replaces it.
  let dead = false;
  conn.on("error", () => (dead = true));
  conn.on("end", () => (dead = true));
  const core = conn.connection;

  async function cancel() {
    const killer = await mysql.createConnection({ ...options, multipleStatements: false });
    try {
      await killer.query(`KILL QUERY ${Number(conn.threadId)}`);
    } finally {
      await killer.end().catch(() => {});
    }
  }

  // Runs a script on the driver's row events. Every result first sends its
  // columns ("fields", undefined for one without rows), then its rows or its
  // OK packet ("result"). Resolves with the last result that had columns
  // (at most limit + 1 of its rows) and a note per statement without rows.
  function stream(text, limit) {
    const statements = splitStatements(text, "mysql").length;
    return new Promise((resolve, reject) => {
      const q = core.query(text);
      let index = -1;
      let current = null;
      let last = null;
      const notes = [];
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({ last, notes });
      };
      q.on("fields", (fields) => {
        index++;
        current = fields ? { fields, rows: [] } : null;
        if (current) last = current;
      });
      q.on("result", (row) => {
        if (Array.isArray(row)) {
          if (!current || current.rows.length > limit) return;
          current.rows.push(row);
          // Past the limit on the script's last result: nothing after it to
          // wait for, so hang up instead of reading the rest.
          if (current.rows.length > limit && index >= statements - 1) {
            dead = true;
            core.stream.destroy();
            finish();
          }
        } else if (row && typeof row === "object" && "affectedRows" in row) {
          notes.push(`${row.affectedRows} rows affected`);
        }
      });
      q.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      q.on("end", finish);
    });
  }

  return {
    engine: "mysql",
    alive: () => !dead,
    async query(text, { limit, timeoutMs, readOnly }) {
      const refused = readOnly ? readOnlyViolation(text, "mysql") : null;
      if (refused) throw new ReadOnlyError(refused);
      const run = async () => {
        if (readOnly) await conn.query("START TRANSACTION READ ONLY");
        try {
          return await stream(text, limit);
        } finally {
          // After a hang-up the server rolls back by itself.
          if (readOnly && !dead) await conn.query("ROLLBACK").catch(() => {});
        }
      };
      let out;
      try {
        out = await withDeadline(run(), timeoutMs, cancel);
      } catch (err) {
        if (err?.errno === 1792 || err?.code === "ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION") throw new ReadOnlyError();
        if (err?.errno === 1317) throw new QueryError("Cancelled", 409);
        throw err instanceof QueryError ? err : new QueryError(err.message);
      }
      const { last, notes } = out;
      if (!last) return { kind: "rows", columns: [], rows: [], truncated: false, rowCount: 0, notes };
      const columns = last.fields.map((c) => ({ name: c.name, type: TYPES[c.columnType] ?? `type ${c.columnType}` }));
      return rowsResult(columns, last.rows, limit, notes);
    },
    cancel,
    async schema() {
      const [tables] = await conn.query(
        `SELECT table_schema, table_name, table_type FROM information_schema.tables
         WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys') ORDER BY 1, 2`,
      );
      const [cols] = await conn.query(
        `SELECT table_schema, table_name, column_name, column_type FROM information_schema.columns
         WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
         ORDER BY table_schema, table_name, ordinal_position`,
      );
      const bySchema = new Map();
      for (const [schema, name, type] of tables) {
        if (!bySchema.has(schema)) bySchema.set(schema, new Map());
        bySchema.get(schema).set(name, { name, kind: type === "VIEW" ? "view" : "table", columns: [] });
      }
      for (const [schema, table, name, type] of cols) bySchema.get(schema)?.get(table)?.columns.push({ name, type });
      return {
        database: options.database ?? null,
        groups: [...bySchema].map(([name, tbls]) => ({ name, kind: "database", children: [...tbls.values()] })),
      };
    },
    tableQuery(group, table) {
      return `SELECT * FROM ${ident(group)}.${ident(table)} LIMIT 100`;
    },
    async close() {
      await conn.end().catch(() => {});
    },
  };
}
