import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createMemoryStorage } from "../../scripts/memoryStorage.mjs";
import { addHistoryEntry, clearHistory, historyPrefix, openSpool, parseDotenv } from "../server.js";
import { chainedNames, formatDate, jsonPath, parseHttpFile, resolveRequest, serverVariableNames } from "./httpFile.ts";
import { toCurl } from "./curl.ts";

describe("request bodies and directives", () => {
  it("keeps # and // lines inside the body", () => {
    const file = parseHttpFile("POST http://x/run\nContent-Type: text/x-sh\n\n#!/bin/sh\n# say hi\necho hi\n// not a comment here\n\n###\nGET http://x/next\n");
    assert.equal(file.requests[0].body, "#!/bin/sh\n# say hi\necho hi\n// not a comment here");
    // Still comments before the request line and among the headers.
    const other = parseHttpFile("# note\n// note\nGET http://x\n# skipped header comment\nA: b\n");
    assert.deepEqual(other.requests[0].headers, [["A", "b"]]);
    assert.equal(other.requests[0].body, "");
  });

  it("reads a file body and @no-redirect", () => {
    const file = parseHttpFile("# @name upload\n# @no-redirect\nPOST http://x\n\n< ./data/{{name}}.json\n###\nPOST http://x\n\n<@ ./tpl.json\n");
    assert.equal(file.requests[0].name, "upload");
    assert.equal(file.requests[0].noRedirect, true);
    assert.equal(file.requests[0].bodyFile, "./data/{{name}}.json");
    assert.equal(file.requests[0].body, "");
    assert.equal(file.requests[1].bodyFileVars, true);
    assert.equal(file.requests[1].noRedirect, undefined);
    const { resolved } = resolveRequest(file.requests[0], { name: "a" }, {}, null);
    assert.equal(resolved.bodyFile, "./data/a.json");
    assert.equal(resolved.noRedirect, true);
    assert.match(toCurl(resolved), /--data-binary '@\.\/data\/a\.json'/);
  });
});

describe("system variables", () => {
  const now = new Date(Date.UTC(2026, 0, 5, 14, 3, 9, 7));
  const one = (expr: string, ctx = {}) => {
    const file = parseHttpFile(`GET http://x/{{${expr}}}`);
    const r = resolveRequest(file.requests[0], {}, {}, null, { now, ...ctx });
    return { url: r.resolved.url.slice("http://x/".length), missing: r.missing };
  };

  it("formats $datetime as iso8601, rfc1123 and a custom format, with an offset", () => {
    assert.equal(one("$datetime iso8601").url, "2026-01-05T14:03:09.007Z");
    assert.equal(one("$datetime rfc1123").url, "Mon, 05 Jan 2026 14:03:09 GMT");
    assert.equal(one(`$datetime "DD.MM.YYYY HH:mm"`).url, "05.01.2026 14:03");
    assert.equal(one(`$datetime 'YYYY-MM-DD[T]HH' -1 d`).url, "2026-01-04T14");
    assert.equal(one("$datetime iso8601 2 h").url, "2026-01-05T16:03:09.007Z");
    assert.deepEqual(one("$datetime").missing, ["$datetime"]);
    assert.equal(formatDate(now, "ddd MMM D h:mm A SSS", true), "Mon Jan 5 2:03 PM 007");
  });

  it("reads $dotenv and $processEnv from what the server returned", () => {
    assert.equal(one("$dotenv API_KEY", { dotenv: { API_KEY: "k1" } }).url, "k1");
    assert.equal(one("$processEnv HOME", { processEnv: { HOME: "/home/me" } }).url, "/home/me");
    assert.deepEqual(one("$dotenv NOPE", { dotenv: {} }).missing, ["$dotenv NOPE"]);
    assert.deepEqual(serverVariableNames("{{$dotenv A}} {{ $processEnv B }} {{$dotenv A}} {{$guid}}"), { dotenv: ["A"], processEnv: ["B"] });
  });

  it("parses .env files", () => {
    assert.deepEqual(parseDotenv('# c\nA=1\nexport B = "two\\nlines"\nC=\'x y\'\nD=plain # note\nbad line\n'), {
      A: "1",
      B: "two\nlines",
      C: "x y",
      D: "plain",
    });
  });
});

describe("request chaining", () => {
  const file = parseHttpFile(
    "# @name login\nPOST http://x/login\n\n{}\n###\nGET http://x/me?id={{login.response.body.$.user.ids[1]}}\nAuthorization: Bearer {{login.response.body.$.token}}\nX-Session: {{login.response.headers.x-session}}\n",
  );
  const named = {
    login: {
      request: { headers: [], body: "{}" },
      response: { headers: [["X-Session", "s9"]] as [string, string][], body: JSON.stringify({ token: "t0k", user: { ids: [1, 2] } }) },
    },
  };

  it("finds the requests a request reads from", () => {
    assert.deepEqual(chainedNames(`${file.requests[1].url}\n${file.requests[1].headers.flat().join("\n")}`), ["login"]);
  });

  it("fills body JSONPath and headers from the named response", () => {
    const { resolved, missing } = resolveRequest(file.requests[1], {}, {}, null, { named });
    assert.deepEqual(missing, []);
    assert.equal(resolved.url, "http://x/me?id=2");
    assert.deepEqual(resolved.headers, [
      ["Authorization", "Bearer t0k"],
      ["X-Session", "s9"],
    ]);
  });

  it("reports a reference with no response yet as missing", () => {
    assert.ok(resolveRequest(file.requests[1], {}, {}, null).missing.includes("login.response.body.$.token"));
  });

  it("walks a small JSONPath", () => {
    const v = { a: { "b c": [{ d: 1 }, { d: 2 }] } };
    assert.equal(jsonPath(v, "$.a['b c'][1].d"), 2);
    assert.equal(jsonPath(v, '$.a["b c"][-1].d'), 2);
    assert.deepEqual(jsonPath(v, "$"), v);
    assert.equal(jsonPath(v, "$.nope.d"), undefined);
    assert.equal(jsonPath(v, "a.b"), undefined);
  });
});

describe("history clear and spool files", () => {
  it("clears one key's history only", async () => {
    const { storage } = createMemoryStorage();
    type Tx = { collection(n: string): unknown };
    await storage.transaction((tx: Tx) => addHistoryEntry(tx.collection("history"), "/a.http", { n: 1 }, 1));
    await storage.transaction((tx: Tx) => addHistoryEntry(tx.collection("history"), "/b.http", { n: 2 }, 2));
    await storage.transaction((tx: Tx) => clearHistory(tx.collection("history"), "/a.http"));
    assert.equal(((await storage.collection("history").list({ prefix: historyPrefix("/a.http") })) as unknown[]).length, 0);
    assert.equal(((await storage.collection("history").list({ prefix: historyPrefix("/b.http") })) as unknown[]).length, 1);
  });

  it("deletes a discarded spool file and reports a failed write", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hc-spool-"));
    const spool = openSpool(path.join(dir, "one"));
    await spool.write(Buffer.alloc(1024));
    await spool.discard();
    assert.equal(existsSync(path.join(dir, "one")), false);
    const broken = openSpool(path.join(dir, "missing-dir", "two"));
    await assert.rejects(async () => {
      // The open fails asynchronously; the error surfaces on a write or finish.
      await new Promise((r) => setTimeout(r, 20));
      await broken.write(Buffer.alloc(10));
    });
    await broken.discard();
  });
});
