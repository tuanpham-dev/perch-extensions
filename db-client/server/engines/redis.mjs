// Redis through `redis`. Read-only connections run only the commands in
// ../readOnly.mjs's allowlist; the key browser and value views use only those.
import { createClient } from "redis";
import { redisCommandAllowed } from "../readOnly.mjs";
import { QueryError, ReadOnlyError, cellValue, connectionMessage, withDeadline } from "./common.mjs";

const SCAN_COUNT = 200;
const MAX_KEYS = 500;
const MAX_ITEMS = 200;

// Shell-like words for the console: quotes group, backslash escapes.
export function commandWords(line) {
  const words = [];
  let word = "";
  let quote = null;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && i + 1 < line.length) word += line[++i];
      else if (c === quote) quote = null;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

const plain = (reply) => {
  if (Array.isArray(reply)) return reply.map(plain);
  if (reply instanceof Map) return Object.fromEntries([...reply].map(([k, v]) => [String(k), plain(v)]));
  if (reply && typeof reply === "object" && !Buffer.isBuffer(reply)) {
    return Object.fromEntries(Object.entries(reply).map(([k, v]) => [k, plain(v)]));
  }
  return cellValue(reply);
};

export async function connectRedis(cfg, password) {
  const host = cfg.host || "localhost";
  const port = Number(cfg.port) || 6379;
  const where = `${host}:${port}`;
  const client = createClient({
    socket: { host, port, connectTimeout: 10_000, reconnectStrategy: false, tls: cfg.ssl ? true : undefined },
    username: cfg.user || undefined,
    password: password ?? undefined,
    database: Number(cfg.database) || 0,
  });
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (err) {
    throw new QueryError(connectionMessage(err, where), 502);
  }

  const send = (args) => client.sendCommand(args.map(String));

  return {
    engine: "redis",
    // The console: one command line.
    async query(text, { timeoutMs, readOnly }) {
      const args = commandWords(text.trim());
      if (!args.length) throw new QueryError("Type a command, such as GET mykey");
      if (readOnly && !redisCommandAllowed(args)) throw new ReadOnlyError();
      try {
        const reply = await withDeadline(send(args), timeoutMs);
        return { kind: "redis", reply: plain(reply) };
      } catch (err) {
        throw err instanceof QueryError ? err : new QueryError(err.message);
      }
    },
    async cancel() {},
    // Keys matching a pattern, with their types.
    async keys(pattern = "*", cursor = "0") {
      const keys = [];
      let next = String(cursor);
      do {
        const [c, batch] = await send(["SCAN", next, "MATCH", pattern || "*", "COUNT", SCAN_COUNT]);
        next = String(c);
        keys.push(...batch.map(String));
      } while (next !== "0" && keys.length < MAX_KEYS);
      const types = await Promise.all(keys.map((k) => send(["TYPE", k]).then(String)));
      return { keys: keys.map((key, i) => ({ key, type: types[i] })), cursor: next };
    },
    // One key's value, shaped by its type, and its TTL in seconds (-1: none).
    async value(key) {
      const type = String(await send(["TYPE", key]));
      const ttl = Number(await send(["TTL", key]));
      let value;
      if (type === "string") value = await send(["GET", key]);
      else if (type === "hash") value = await send(["HGETALL", key]);
      else if (type === "list") value = await send(["LRANGE", key, 0, MAX_ITEMS - 1]);
      else if (type === "set") value = (await send(["SSCAN", key, 0, "COUNT", MAX_ITEMS]))[1];
      else if (type === "zset") value = await send(["ZRANGE", key, 0, MAX_ITEMS - 1, "WITHSCORES"]);
      else if (type === "stream") value = await send(["XRANGE", key, "-", "+", "COUNT", 100]);
      else if (type === "none") throw new QueryError(`No key named ${key}`, 404);
      else value = null;
      const length =
        type === "list" ? Number(await send(["LLEN", key])) : type === "set" ? Number(await send(["SCARD", key])) : type === "zset" ? Number(await send(["ZCARD", key])) : type === "hash" ? Number(await send(["HLEN", key])) : type === "stream" ? Number(await send(["XLEN", key])) : null;
      return { kind: "value", key, type, ttl, length, value: plain(value) };
    },
    // Key groups by the part before the first ":", from a sample of keys.
    async schema() {
      const { keys } = await this.keys("*");
      const groups = new Map();
      for (const { key } of keys) {
        const prefix = key.includes(":") ? `${key.split(":")[0]}:*` : "(no prefix)";
        groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
      }
      return {
        database: `db ${Number(cfg.database) || 0}`,
        groups: [
          {
            name: `db ${Number(cfg.database) || 0}`,
            kind: "database",
            children: [...groups].sort().map(([name, count]) => ({ name, kind: "keys", count, columns: [] })),
          },
        ],
      };
    },
    tableQuery() {
      return "";
    },
    async close() {
      await client.quit().catch(() => client.disconnect().catch(() => {}));
    },
  };
}
