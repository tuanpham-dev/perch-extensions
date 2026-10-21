// Redis through `redis`. Read-only connections run only the commands in
// ../readOnly.mjs's allowlist; the key browser and value views use only those.
// A blocking command (BLPOP, XREAD BLOCK, SUBSCRIBE…) runs on a client of its
// own, opened for it and closed after, so it holds up nothing else.
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

// Commands that wait on the server: always, or with a BLOCK argument.
const BLOCKING = new Set(["BLPOP", "BRPOP", "BRPOPLPUSH", "BLMOVE", "BLMPOP", "BZPOPMIN", "BZPOPMAX", "BZMPOP", "WAIT", "WAITAOF"]);
// Commands that turn a connection into a listener; the console collects what
// they hear until the row limit, the timeout or Cancel.
const LISTENING = new Set(["SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "MONITOR"]);

export function isBlockingCommand(args) {
  const name = String(args[0] ?? "").toUpperCase();
  if (BLOCKING.has(name) || LISTENING.has(name)) return true;
  return (name === "XREAD" || name === "XREADGROUP") && args.some((a) => String(a).toUpperCase() === "BLOCK");
}

// A reply with at most `limit` items at its top level (a long LRANGE 0 -1 or
// HGETALL), and whether some were left out.
export function capReply(reply, limit) {
  if (Array.isArray(reply) && reply.length > limit) return { reply: reply.slice(0, limit), truncated: true, rowCount: reply.length };
  if (reply instanceof Map && reply.size > limit) return { reply: new Map([...reply].slice(0, limit)), truncated: true, rowCount: reply.size };
  if (reply && typeof reply === "object" && !Array.isArray(reply) && !(reply instanceof Map) && !Buffer.isBuffer(reply)) {
    const entries = Object.entries(reply);
    if (entries.length > limit) return { reply: Object.fromEntries(entries.slice(0, limit)), truncated: true, rowCount: entries.length };
  }
  return { reply, truncated: false };
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

  // The blocking commands in flight, each on its own client: id -> stop().
  const blocking = new Map();
  let blockingSeq = 0;

  // A blocking command on a client of its own. A plain blocking command
  // resolves with its reply; Cancel or the timeout hangs up that client. A
  // listener resolves with what it heard, when it has `limit` messages, at
  // the timeout or on Cancel.
  async function runBlocking(args, { limit, timeoutMs }) {
    const own = client.duplicate();
    own.on("error", () => {});
    try {
      await own.connect();
    } catch (err) {
      throw new QueryError(connectionMessage(err, where), 502);
    }
    const id = ++blockingSeq;
    const name = String(args[0]).toUpperCase();
    try {
      if (!LISTENING.has(name)) {
        let cancelled = false;
        blocking.set(id, () => {
          cancelled = true;
          own.destroy();
        });
        try {
          return { reply: await withDeadline(own.sendCommand(args.map(String)), timeoutMs, () => own.destroy()), truncated: false };
        } catch (err) {
          if (cancelled) throw new QueryError("Cancelled", 409);
          throw err;
        }
      }
      const heard = [];
      let done;
      const finished = new Promise((resolve) => (done = resolve));
      const hear = (entry) => {
        if (heard.length < limit) heard.push(entry);
        if (heard.length >= limit) done();
      };
      blocking.set(id, () => done());
      const timer = setTimeout(() => done(), timeoutMs);
      try {
        const targets = args.slice(1).map(String);
        if (name === "MONITOR") await own.monitor((line) => hear(line));
        else if (!targets.length) throw new QueryError(`${name} needs at least one channel`);
        else if (name === "SUBSCRIBE") await own.subscribe(targets, (message, channel) => hear({ channel, message }));
        else if (name === "SSUBSCRIBE") await own.sSubscribe(targets, (message, channel) => hear({ channel, message }));
        else await own.pSubscribe(targets, (message, channel) => hear({ channel, message }));
        await finished;
      } finally {
        clearTimeout(timer);
      }
      return { reply: heard, truncated: heard.length >= limit, notes: [`Listened ${heard.length >= limit ? `until ${limit} messages` : "until stopped"}`] };
    } finally {
      blocking.delete(id);
      own.destroy();
    }
  }

  return {
    engine: "redis",
    alive: () => client.isReady,
    // The console: one command line.
    async query(text, { limit, timeoutMs, readOnly }) {
      const args = commandWords(text.trim());
      if (!args.length) throw new QueryError("Type a command, such as GET mykey");
      if (readOnly && !redisCommandAllowed(args)) throw new ReadOnlyError();
      try {
        const out = isBlockingCommand(args) ? await runBlocking(args, { limit, timeoutMs }) : { reply: await withDeadline(send(args), timeoutMs) };
        // Redis sends a reply whole, so the cap is on what comes back here.
        const capped = out.truncated === undefined ? capReply(out.reply, limit) : out;
        return { kind: "redis", reply: plain(capped.reply), truncated: capped.truncated, rowCount: capped.rowCount, notes: out.notes ?? [] };
      } catch (err) {
        throw err instanceof QueryError ? err : new QueryError(err.message);
      }
    },
    // Only a blocking command can be stopped: the others are one round trip.
    async cancel() {
      for (const stop of [...blocking.values()]) stop();
    },
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
      for (const stop of [...blocking.values()]) stop();
      await client.quit().catch(() => client.disconnect().catch(() => {}));
    },
  };
}
