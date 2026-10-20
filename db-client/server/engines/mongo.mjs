// MongoDB through `mongodb`. Filters, projections, sorts and pipelines are
// Extended JSON ({"$oid": "…"}, {"$date": "…"}). A read-only connection runs
// only find, aggregate without $out/$merge, countDocuments, distinct and
// the listings; nothing else is exposed at all.
import { BSON, MongoClient } from "mongodb";
import { pipelineWrites } from "../readOnly.mjs";
import { QueryError, ReadOnlyError, connectionMessage, withDeadline } from "./common.mjs";

const { EJSON } = BSON;

function parseJson(text, what) {
  if (!text || !String(text).trim()) return undefined;
  try {
    return EJSON.parse(String(text), { relaxed: true });
  } catch (err) {
    throw new QueryError(`${what} isn't valid JSON: ${err.message}`);
  }
}

const toPlain = (docs) => docs.map((d) => EJSON.serialize(d, { relaxed: true }));

export async function connectMongo(cfg, password) {
  let uri = cfg.url;
  if (!uri) {
    const auth = cfg.user ? `${encodeURIComponent(cfg.user)}${password ? `:${encodeURIComponent(password)}` : ""}@` : "";
    uri = `mongodb://${auth}${cfg.host || "localhost"}:${Number(cfg.port) || 27017}/${cfg.database ?? ""}`;
  } else if (password && !/\/\/[^/]*:[^/]*@/.test(uri)) {
    uri = uri.replace(/^(mongodb(?:\+srv)?:\/\/)([^@/:]+)@/, (_m, s, user) => `${s}${user}:${encodeURIComponent(password)}@`);
  }
  const where = cfg.host ? `${cfg.host}:${Number(cfg.port) || 27017}` : (uri.match(/@([^/?]+)/)?.[1] ?? uri.replace(/^mongodb(\+srv)?:\/\//, "").split("/")[0]);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8_000, connectTimeoutMS: 10_000, appName: "Perch DB Client" });
  try {
    await client.connect();
  } catch (err) {
    throw new QueryError(connectionMessage(err, where), 502);
  }
  const defaultDb = client.options?.dbName || cfg.database || "test";
  const running = new Set();

  return {
    engine: "mongo",
    // { db, collection, mode: "find" | "aggregate", filter, projection, sort, pipeline }
    async query(spec, { limit, timeoutMs, readOnly }) {
      const db = client.db(spec.db || defaultDb);
      if (!spec.collection) throw new QueryError("Choose a collection");
      const coll = db.collection(spec.collection);
      let cursor;
      if (spec.mode === "aggregate") {
        const pipeline = parseJson(spec.pipeline, "The pipeline") ?? [];
        if (!Array.isArray(pipeline)) throw new QueryError("The pipeline must be a JSON list of stages");
        if (readOnly && pipelineWrites(pipeline)) throw new ReadOnlyError();
        cursor = coll.aggregate(pipeline, { maxTimeMS: timeoutMs });
      } else {
        cursor = coll.find(parseJson(spec.filter, "The filter") ?? {}, {
          projection: parseJson(spec.projection, "The projection"),
          sort: parseJson(spec.sort, "The sort"),
          maxTimeMS: timeoutMs,
        });
      }
      cursor.limit?.(limit + 1);
      running.add(cursor);
      try {
        const docs = await withDeadline(cursor.toArray(), timeoutMs + 1000, () => cursor.close());
        return { kind: "docs", docs: toPlain(docs.slice(0, limit)), truncated: docs.length > limit, rowCount: docs.length };
      } catch (err) {
        throw err instanceof QueryError ? err : new QueryError(err.message);
      } finally {
        running.delete(cursor);
        await cursor.close().catch(() => {});
      }
    },
    async cancel() {
      await Promise.all([...running].map((c) => c.close().catch(() => {})));
    },
    async schema() {
      let names;
      try {
        names = (await client.db().admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
      } catch {
        names = [defaultDb];
      }
      names = names.filter((n) => !["admin", "config", "local"].includes(n));
      const groups = await Promise.all(
        names.map(async (name) => ({
          name,
          kind: "database",
          children: (await client.db(name).listCollections({}, { nameOnly: true }).toArray())
            .map((c) => ({ name: c.name, kind: "collection", columns: [] }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        })),
      );
      return { database: defaultDb, groups };
    },
    tableQuery() {
      return "";
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}
