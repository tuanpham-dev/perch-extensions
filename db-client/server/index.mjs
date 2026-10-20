// DB Client server hook, bundled with its drivers into dist/server.js (see
// perch-extensions/scripts/build.mjs). Connections are saved per user in
// Perch's extension storage (Perch 0.9+); passwords go to Perch's secret store
// (`secrets`) and never come back to a browser. A connection is read-only
// until the user switches it to writable, and read-only is enforced here, per
// engine (see engines/).
//
//   GET    /connections                    saved connections, no passwords
//   POST   /connections                    { name, engine, host, port, database, user, file, url, ssl, password } | { fromEnv: { file, key } }
//   PUT    /connections/:id                fields, password (null clears), writable (+ confirm: true to turn it on)
//   DELETE /connections/:id
//   POST   /connections/parse-url          { url } -> fields
//   GET    /suggest?dir=                   connection URLs found in the project's .env files
//   GET    /schema?id=
//   POST   /query                          { id, queryId, text } | { id, queryId, spec } (MongoDB)
//   POST   /cancel                         { queryId }
//   GET    /history?id=
//   GET    /redis/keys?id=&pattern=        GET /redis/value?id=&key=
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QueryError } from "./engines/common.mjs";
import { connectMongo } from "./engines/mongo.mjs";
import { connectMysql } from "./engines/mysql.mjs";
import { connectPostgres } from "./engines/postgres.mjs";
import { connectRedis } from "./engines/redis.mjs";
import { connectSqlite } from "./engines/sqlite.mjs";

// Connections and query history live in the host's extension storage (Perch
// 0.9+): collection "connections" holds one record per connection (keyed by
// id, `order` keeping the list's order), and collection "history" one record
// per query run, keyed "<connection id>/<zero-padded ms>" so a connection's
// history is a prefix and sorts oldest first. Passwords stay in `secrets`.

export const ENGINES = ["sqlite", "postgres", "mysql", "redis", "mongo"];
const FIELDS = ["name", "engine", "host", "port", "database", "user", "file", "url", "ssl"];
const IDLE_MS = 5 * 60 * 1000;
const HISTORY_PER_CONNECTION = 100;

function expandHome(p) {
  if (typeof p !== "string") return "";
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// A history key: the connection's prefix, then a fixed-width timestamp.
export const historyKey = (id, at) => `${id}/${String(at).padStart(15, "0")}`;

// Records one query in `tx`'s history collection: the same text run before
// moves to the top, and only the newest `limit` are kept.
export function addHistory(history, id, text, at, limit = HISTORY_PER_CONNECTION) {
  const prefix = `${id}/`;
  for (const r of history.list({ prefix })) if (r.value.text === text) history.delete(r.key);
  history.put(historyKey(id, at), { at, text });
  const all = history.list({ prefix, keysOnly: true });
  for (const r of all.slice(0, Math.max(0, all.length - limit))) history.delete(r.key);
}

// A connection URL as fields plus its password (which goes to secrets).
export function parseConnectionUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new QueryError("Enter a connection URL");
  if (/^sqlite:/i.test(text) || /^file:/i.test(text)) {
    const file = decodeURIComponent(text.replace(/^(sqlite|file):(\/\/)?/i, ""));
    return { fields: { engine: "sqlite", file, name: path.basename(file) }, password: null };
  }
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new QueryError(`Not a connection URL: ${text}`);
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  const engine =
    scheme === "postgres" || scheme === "postgresql"
      ? "postgres"
      : scheme === "mysql" || scheme === "mariadb"
        ? "mysql"
        : scheme === "redis" || scheme === "rediss"
          ? "redis"
          : scheme === "mongodb" || scheme === "mongodb+srv"
            ? "mongo"
            : null;
  if (!engine) throw new QueryError(`Unsupported database type: ${scheme}`);
  const password = u.password ? decodeURIComponent(u.password) : null;
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const fields = {
    engine,
    host: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    user: u.username ? decodeURIComponent(u.username) : undefined,
    database: database || undefined,
    ssl: scheme === "rediss" || /sslmode=(require|verify)/i.test(u.search) || /ssl=true/i.test(u.search) || undefined,
    name: `${u.hostname}${database ? `/${database}` : ""}`,
  };
  if (engine === "mongo") {
    // Kept whole for the driver (options, replica sets, +srv), minus the password.
    u.password = "";
    fields.url = u.toString();
  }
  return { fields, password };
}

// DATABASE_URL-style lines in .env files.
const ENV_KEYS = /^(DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|PG_URL|MYSQL_URL|REDIS_URL|REDIS_URI|MONGODB_URI|MONGO_URL|MONGO_URI)\s*=\s*(.*)$/;

async function envUrls(dir) {
  const out = [];
  for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    const file = path.join(dir, name);
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = ENV_KEYS.exec(line.trim().replace(/^export\s+/, ""));
      if (!m) continue;
      const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (value) out.push({ file, key: m[1], url: value });
    }
  }
  return out;
}

const masked = (url) => url.replace(/(\/\/[^:/@]*:)([^@]*)@/, "$1•••@");

function publicConnection(c, hasPassword) {
  return { ...c, hasPassword };
}

// Set by activate(): closes every open connection, for deactivate().
let closeAll = null;

export function activate({ router, getSettings, secrets, log, storage }) {
  // A Perch older than 0.9 has no extension storage to keep connections in.
  if (!storage) {
    log?.("DB Client needs Perch 0.9 or newer (no extension storage)");
    return;
  }
  const secretName = (id) => `db.${id}`;
  const getPassword = async (id) => (secrets?.get ? secrets.get(secretName(id)) : null);
  const setPassword = async (id, value) => {
    if (!secrets?.set) {
      if (value) throw new QueryError("This Perch has no secret store, so passwords can't be saved");
      return;
    }
    await secrets.set(secretName(id), value || null);
  };

  let writes = Promise.resolve();
  const loadConnections = async () =>
    (await storage.collection("connections").list())
      .map((r) => r.value)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(({ order: _order, ...conn }) => conn);
  // fn(list) changes the list in place (it may be async); the result is
  // stored in one transaction: every connection put with its position, and
  // any no longer in the list deleted.
  const saveConnections = (fn) => {
    const run = writes.then(async () => {
      const list = await loadConnections();
      const result = await fn(list);
      await storage.transaction((tx) => {
        const c = tx.collection("connections");
        const keep = new Set(list.map((conn) => conn.id));
        for (const r of c.list()) if (!keep.has(r.key)) c.delete(r.key);
        list.forEach((conn, order) => c.put(conn.id, { ...conn, order }));
      });
      return result;
    });
    writes = run.catch(() => {});
    return run;
  };

  // ---- Open connections ----
  const pool = new Map(); // id -> { key, adapter: Promise, timer }
  const running = new Map(); // queryId -> adapter

  // getSettings() resolves to this extension's settings, defaults included.
  const settingNumber = async (key, fallback, min, max) => {
    const n = Number((await getSettings?.())?.[key]);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };

  async function closeEntry(id) {
    const entry = pool.get(id);
    pool.delete(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    try {
      await (await entry.adapter).close();
    } catch {
      // never opened
    }
  }

  closeAll = async () => {
    await Promise.all([...pool.keys()].map((id) => closeEntry(id)));
  };

  async function adapterFor(conn) {
    const key = JSON.stringify(conn);
    let entry = pool.get(conn.id);
    if (entry && entry.key !== key) {
      await closeEntry(conn.id);
      entry = null;
    }
    if (!entry) {
      const password = await getPassword(conn.id);
      const open =
        conn.engine === "sqlite"
          ? connectSqlite({ ...conn, file: path.resolve(expandHome(conn.file)) })
          : conn.engine === "postgres"
            ? connectPostgres(conn, password)
            : conn.engine === "mysql"
              ? connectMysql(conn, password)
              : conn.engine === "redis"
                ? connectRedis(conn, password)
                : connectMongo(conn, password);
      entry = { key, adapter: open, timer: null };
      pool.set(conn.id, entry);
      open.catch(() => pool.get(conn.id) === entry && pool.delete(conn.id));
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void closeEntry(conn.id), IDLE_MS);
    entry.timer.unref?.();
    return entry.adapter;
  }

  async function findConnection(id) {
    const conn = (await loadConnections()).find((c) => c.id === id);
    if (!conn) throw new QueryError("No such connection", 404);
    return conn;
  }

  const fail = (res, err) => {
    const status = err instanceof QueryError ? err.status : 500;
    if (!(err instanceof QueryError)) log?.("db-client:", err?.message);
    res.status(status).json({ error: err?.message ?? String(err) });
  };

  function cleanFields(body) {
    const out = {};
    for (const k of FIELDS) {
      if (body[k] === undefined || body[k] === null || body[k] === "") continue;
      out[k] = k === "port" ? Number(body[k]) : k === "ssl" ? Boolean(body[k]) : String(body[k]).trim();
    }
    if (out.engine && !ENGINES.includes(out.engine)) throw new QueryError(`Unsupported database type: ${out.engine}`);
    return out;
  }

  // ---- Routes ----

  router.get("/connections", async (_req, res) => {
    try {
      const list = await loadConnections();
      const withFlags = await Promise.all(list.map(async (c) => publicConnection(c, Boolean(await getPassword(c.id)))));
      res.json({ connections: withFlags });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/connections/parse-url", (req, res) => {
    try {
      const { fields, password } = parseConnectionUrl(req.body?.url);
      res.json({ fields, hasPassword: Boolean(password) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/connections", async (req, res) => {
    try {
      let fields;
      let password = null;
      if (req.body?.fromEnv) {
        const { file, key } = req.body.fromEnv;
        const found = (await envUrls(path.dirname(String(file)))).find((e) => e.file === file && e.key === key);
        if (!found) throw new QueryError(`${key} is no longer in ${file}`, 404);
        ({ fields, password } = parseConnectionUrl(found.url));
      } else if (req.body?.url) {
        ({ fields, password } = parseConnectionUrl(req.body.url));
        if (req.body.name) fields.name = String(req.body.name);
      } else {
        fields = cleanFields(req.body ?? {});
        password = typeof req.body?.password === "string" && req.body.password ? req.body.password : null;
      }
      if (!fields.engine) throw new QueryError("Choose a database type");
      if (fields.engine === "sqlite" && !fields.file) throw new QueryError("Choose a SQLite file");
      const conn = { id: `conn_${randomBytes(5).toString("hex")}`, ...fields, name: fields.name || fields.engine, writable: false };
      if (fields.engine === "sqlite") conn.file = path.resolve(expandHome(conn.file));
      await setPassword(conn.id, password);
      await saveConnections((list) => list.push(conn));
      res.status(201).json(publicConnection(conn, Boolean(password)));
    } catch (err) {
      fail(res, err);
    }
  });

  router.put("/connections/:id", async (req, res) => {
    try {
      const body = req.body ?? {};
      const updated = await saveConnections(async (list) => {
        const conn = list.find((c) => c.id === req.params.id);
        if (!conn) throw new QueryError("No such connection", 404);
        Object.assign(conn, cleanFields(body));
        if (body.writable === true && !conn.writable) {
          if (body.confirm !== true) throw new QueryError("Confirm to make this connection writable", 428);
          conn.writable = true;
        } else if (body.writable === false) {
          conn.writable = false;
        }
        if (body.password !== undefined) await setPassword(conn.id, body.password || null);
        return { ...conn };
      });
      await closeEntry(updated.id);
      res.json(publicConnection(updated, Boolean(await getPassword(updated.id))));
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete("/connections/:id", async (req, res) => {
    try {
      await saveConnections((list) => {
        const i = list.findIndex((c) => c.id === req.params.id);
        if (i === -1) throw new QueryError("No such connection", 404);
        list.splice(i, 1);
      });
      await closeEntry(req.params.id);
      await setPassword(req.params.id, null).catch(() => {});
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/suggest", async (req, res) => {
    try {
      const dir = path.resolve(expandHome(String(req.query.dir ?? "")));
      const saved = await loadConnections();
      const found = (await envUrls(dir)).map((e) => {
        try {
          const { fields } = parseConnectionUrl(e.url);
          return { file: e.file, key: e.key, engine: fields.engine, display: masked(e.url), name: fields.name };
        } catch {
          return null;
        }
      });
      // Drop ones already saved (same engine, host and database).
      const isSaved = (s) => saved.some((c) => c.engine === s.engine && c.name === s.name);
      res.json({ suggestions: found.filter((s) => s && !isSaved(s)) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/schema", async (req, res) => {
    try {
      const conn = await findConnection(String(req.query.id));
      const adapter = await adapterFor(conn);
      res.json(await adapter.schema());
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/query", async (req, res) => {
    const { id, queryId, text, spec } = req.body ?? {};
    try {
      const conn = await findConnection(String(id));
      const adapter = await adapterFor(conn);
      const limit = await settingNumber("dbClient.rowLimit", 1000, 1, 100_000);
      const timeoutMs = (await settingNumber("dbClient.timeoutSeconds", 30, 1, 3600)) * 1000;
      if (queryId) running.set(String(queryId), adapter);
      const started = performance.now();
      let result;
      try {
        result = await adapter.query(conn.engine === "mongo" ? (spec ?? {}) : String(text ?? ""), { limit, timeoutMs, readOnly: !conn.writable });
      } finally {
        if (queryId) running.delete(String(queryId));
      }
      result.timeMs = Math.round(performance.now() - started);
      result.limit = limit;
      void recordHistory(conn.id, conn.engine === "mongo" ? JSON.stringify(spec ?? {}) : String(text ?? ""));
      res.json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/cancel", async (req, res) => {
    const adapter = running.get(String(req.body?.queryId ?? ""));
    try {
      await adapter?.cancel();
    } catch (err) {
      log?.("cancel failed:", err.message);
    }
    res.status(204).end();
  });

  // One transaction per query run: no other write can land in between.
  function recordHistory(id, text) {
    if (!text.trim()) return Promise.resolve();
    return storage
      .transaction((tx) => addHistory(tx.collection("history"), id, text, Date.now()))
      .catch((err) => log?.("could not record history:", err?.message ?? err));
  }

  router.get("/history", async (req, res) => {
    const rows = await storage.collection("history").list({ prefix: `${String(req.query.id)}/` });
    // Newest first, as before.
    res.json({ entries: rows.reverse().map((r) => r.value) });
  });

  router.get("/redis/keys", async (req, res) => {
    try {
      const conn = await findConnection(String(req.query.id));
      if (conn.engine !== "redis") throw new QueryError("Not a Redis connection");
      const adapter = await adapterFor(conn);
      res.json(await adapter.keys(String(req.query.pattern || "*"), String(req.query.cursor || "0")));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/redis/value", async (req, res) => {
    try {
      const conn = await findConnection(String(req.query.id));
      if (conn.engine !== "redis") throw new QueryError("Not a Redis connection");
      const adapter = await adapterFor(conn);
      res.json(await adapter.value(String(req.query.key ?? "")));
    } catch (err) {
      fail(res, err);
    }
  });
}

export async function deactivate() {
  await closeAll?.();
  closeAll = null;
}
