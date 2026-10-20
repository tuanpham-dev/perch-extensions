// What a read-only connection may run on the engines without SQL
// transactions. SQL engines get a read-only transaction instead (see
// engines/postgres.mjs, engines/mysql.mjs) and SQLite a read-only file
// handle; these two need an allowlist.

// Redis commands that only read. Anything else, including CONFIG, EVAL and
// MULTI, is refused on a read-only connection.
export const REDIS_READ_COMMANDS = new Set([
  "GET", "MGET", "GETRANGE", "STRLEN", "EXISTS", "TYPE", "TTL", "PTTL", "EXPIRETIME", "PEXPIRETIME",
  "HGET", "HMGET", "HGETALL", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HSTRLEN", "HSCAN", "HRANDFIELD",
  "LRANGE", "LLEN", "LINDEX", "LPOS",
  "SMEMBERS", "SCARD", "SISMEMBER", "SMISMEMBER", "SSCAN", "SRANDMEMBER", "SINTER", "SUNION", "SDIFF", "SINTERCARD",
  "ZRANGE", "ZRANGEBYSCORE", "ZRANGEBYLEX", "ZREVRANGE", "ZREVRANGEBYSCORE", "ZREVRANGEBYLEX", "ZCARD", "ZSCORE",
  "ZMSCORE", "ZRANK", "ZREVRANK", "ZCOUNT", "ZLEXCOUNT", "ZSCAN", "ZRANDMEMBER",
  "XRANGE", "XREVRANGE", "XLEN", "XINFO",
  "BITCOUNT", "BITPOS", "GETBIT", "PFCOUNT", "GEOPOS", "GEODIST", "GEOSEARCH", "GEOHASH",
  "SCAN", "KEYS", "RANDOMKEY", "DBSIZE", "INFO", "PING", "ECHO", "TIME", "MEMORY", "OBJECT", "DUMP", "LASTSAVE",
]);

// MEMORY/OBJECT/XINFO/INFO have subcommands; these are the ones that only read.
const REDIS_READ_SUBCOMMANDS = {
  MEMORY: new Set(["USAGE", "STATS", "DOCTOR"]),
  OBJECT: new Set(["ENCODING", "FREQ", "IDLETIME", "REFCOUNT"]),
  XINFO: new Set(["STREAM", "GROUPS", "CONSUMERS"]),
};

export function redisCommandAllowed(args) {
  const name = String(args[0] ?? "").toUpperCase();
  if (!REDIS_READ_COMMANDS.has(name)) return false;
  const subs = REDIS_READ_SUBCOMMANDS[name];
  return subs ? subs.has(String(args[1] ?? "").toUpperCase()) : true;
}

// An aggregation pipeline that writes: a $out or $merge stage anywhere,
// including inside $facet / $lookup / $unionWith sub-pipelines.
export function pipelineWrites(pipeline) {
  const visit = (value) => {
    if (Array.isArray(value)) return value.some(visit);
    if (value && typeof value === "object") {
      return Object.entries(value).some(([k, v]) => k === "$out" || k === "$merge" || visit(v));
    }
    return false;
  };
  return visit(pipeline);
}
