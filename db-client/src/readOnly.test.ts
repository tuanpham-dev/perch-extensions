import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pipelineWrites, redisCommandAllowed } from "../server/readOnly.mjs";
import { blankLiterals, splitStatements, txControlIn } from "../server/sqlText.mjs";
import { parseConnectionUrl } from "../server/index.mjs";

describe("read-only rules", () => {
  it("lets Redis read commands through and stops writes", () => {
    assert.equal(redisCommandAllowed(["get", "k"]), true);
    assert.equal(redisCommandAllowed(["HGETALL", "user:1"]), true);
    assert.equal(redisCommandAllowed(["SET", "k", "v"]), false);
    assert.equal(redisCommandAllowed(["FLUSHALL"]), false);
    assert.equal(redisCommandAllowed(["EVAL", "return 1", "0"]), false);
    assert.equal(redisCommandAllowed(["MEMORY", "USAGE", "k"]), true);
    assert.equal(redisCommandAllowed(["MEMORY", "PURGE"]), false);
  });

  it("finds $out and $merge anywhere in a pipeline", () => {
    assert.equal(pipelineWrites([{ $match: { a: 1 } }, { $group: { _id: "$a" } }]), false);
    assert.equal(pipelineWrites([{ $out: "copy" }]), true);
    assert.equal(pipelineWrites([{ $facet: { a: [{ $merge: { into: "x" } }] } }]), true);
    assert.equal(pipelineWrites([{ $lookup: { from: "b", pipeline: [{ $out: "y" }], as: "z" } }]), true);
  });

  it("refuses statements that would leave the read-only transaction, not columns that share their names", () => {
    assert.equal(txControlIn("select release, begin, commit from t"), null);
    assert.equal(txControlIn("select 'commit; drop table x'"), null);
    assert.equal(txControlIn("COMMIT; DELETE FROM users"), "COMMIT");
    assert.equal(txControlIn("select 1;\n  rollback"), "ROLLBACK");
    assert.equal(txControlIn("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE"), "SET SESSION CHARACTERISTICS");
    assert.equal(txControlIn("set default_transaction_read_only = off"), "SET DEFAULT_TRANSACTION_READ_ONLY");
    assert.equal(txControlIn("SET @@autocommit = 1"), "SET @@AUTOCOMMIT");
    assert.equal(txControlIn("/* hi */ start transaction read write"), "START TRANSACTION");
  });
});

describe("SQL text", () => {
  it("splits on semicolons outside literals, quoted names, dollar quotes and comments", () => {
    assert.deepEqual(splitStatements("select 'a;b'; select \"x;y\" from t; -- c;d\nselect $$e;f$$; /* ; */"), [
      "select 'a;b'",
      'select "x;y" from t',
      "-- c;d\nselect $$e;f$$",
    ]);
  });

  it("keeps offsets when blanking", () => {
    const sql = "select 'it''s' as x";
    assert.equal(blankLiterals(sql).length, sql.length);
  });
});

describe("connection URLs", () => {
  it("reads each engine's URL and keeps the password out of the fields", () => {
    const pg = parseConnectionUrl("postgres://app:s%40cret@db.local:5433/shop?sslmode=require");
    assert.deepEqual(pg.fields, { engine: "postgres", host: "db.local", port: 5433, user: "app", database: "shop", ssl: true, name: "db.local/shop" });
    assert.equal(pg.password, "s@cret");
    assert.equal(parseConnectionUrl("mysql://root@localhost/app").fields.engine, "mysql");
    const redis = parseConnectionUrl("redis://:pw@cache:6380/2");
    assert.deepEqual([redis.fields.engine, redis.fields.port, redis.fields.database, redis.password], ["redis", 6380, "2", "pw"]);
    const mongo = parseConnectionUrl("mongodb+srv://u:p@cluster.example.net/app?retryWrites=true");
    assert.equal(mongo.fields.engine, "mongo");
    assert.equal(mongo.password, "p");
    assert.ok(!mongo.fields.url.includes(":p@"));
    assert.equal(parseConnectionUrl("sqlite:///tmp/app.db").fields.file, "/tmp/app.db");
    assert.throws(() => parseConnectionUrl("ftp://x"), /Unsupported database type: ftp/);
  });
});
