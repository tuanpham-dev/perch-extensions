// MySQL and MariaDB through `mysql2`. A read-only connection runs each query
// inside START TRANSACTION READ ONLY … ROLLBACK and refuses statements that
// would end that transaction (see ../sqlText.mjs).
import mysql from "mysql2/promise";
import { txControlIn } from "../sqlText.mjs";
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
  conn.on("error", () => {});

  async function cancel() {
    const killer = await mysql.createConnection({ ...options, multipleStatements: false });
    try {
      await killer.query(`KILL QUERY ${Number(conn.threadId)}`);
    } finally {
      await killer.end().catch(() => {});
    }
  }

  return {
    engine: "mysql",
    async query(text, { limit, timeoutMs, readOnly }) {
      if (readOnly && txControlIn(text)) throw new ReadOnlyError();
      const run = async () => {
        if (readOnly) await conn.query("START TRANSACTION READ ONLY");
        try {
          return await conn.query(text);
        } finally {
          if (readOnly) await conn.query("ROLLBACK").catch(() => {});
        }
      };
      let results;
      let fields;
      try {
        [results, fields] = await withDeadline(run(), timeoutMs, cancel);
      } catch (err) {
        if (err?.errno === 1792 || err?.code === "ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION") throw new ReadOnlyError();
        if (err?.errno === 1317) throw new QueryError("Cancelled", 409);
        throw err instanceof QueryError ? err : new QueryError(err.message);
      }
      // One statement gives (rows, fields); several give a list of each.
      const multi = Array.isArray(fields) && fields.length > 0 && (Array.isArray(fields[0]) || fields[0] === undefined);
      const sets = multi ? results.map((r, i) => [r, fields[i]]) : [[results, fields]];
      const notes = [];
      let last = null;
      for (const [r, f] of sets) {
        if (Array.isArray(r) && Array.isArray(f)) last = [r, f];
        else if (r && typeof r === "object" && "affectedRows" in r) notes.push(`${r.affectedRows} rows affected`);
      }
      if (!last) return { kind: "rows", columns: [], rows: [], truncated: false, rowCount: 0, notes };
      const columns = last[1].map((c) => ({ name: c.name, type: TYPES[c.columnType] ?? `type ${c.columnType}` }));
      return rowsResult(columns, last[0], limit, notes);
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
