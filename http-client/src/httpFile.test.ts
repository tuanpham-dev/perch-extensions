import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRequest, mergeEnvironments, parseHttpFile, resolveRequest } from "./httpFile.ts";
import { fromCurl, shellWords, toCurl } from "./curl.ts";

const sample = `@base = http://localhost:3000
@api = {{base}}/api

# @name listProjects
GET {{api}}/sessions
Authorization: Bearer {{token}}

###
// a note
POST {{api}}/sessions HTTP/1.1
Content-Type: application/json

{ "cwd": "/home/me/shop" }

### plain url, query continued
https://example.com/search
  ?q=perch
  &page=2
`;

describe(".http files", () => {
  it("reads variables, names, methods, headers and bodies", () => {
    const file = parseHttpFile(sample);
    assert.deepEqual(file.variables, { base: "http://localhost:3000", api: "{{base}}/api" });
    assert.equal(file.requests.length, 3);
    assert.deepEqual(file.requests[0], {
      name: "listProjects",
      method: "GET",
      url: "{{api}}/sessions",
      headers: [["Authorization", "Bearer {{token}}"]],
      body: "",
      startLine: 4,
    });
    assert.equal(file.requests[1].method, "POST");
    assert.equal(file.requests[1].url, "{{api}}/sessions");
    assert.equal(file.requests[1].body, '{ "cwd": "/home/me/shop" }');
    assert.equal(file.requests[2].method, "GET");
    assert.equal(file.requests[2].url, "https://example.com/search?q=perch&page=2");
  });

  it("fills variables from the file and the environment, and reports missing ones", () => {
    const file = parseHttpFile(sample);
    const envs = mergeEnvironments({ local: { token: "shared" }, $shared: { x: "1" } }, { local: { token: "private" } });
    const ok = resolveRequest(file.requests[0], file.variables, envs, "local");
    assert.equal(ok.resolved.url, "http://localhost:3000/api/sessions");
    assert.deepEqual(ok.resolved.headers, [["Authorization", "Bearer private"]]);
    assert.deepEqual(ok.missing, []);
    const missing = resolveRequest(file.requests[0], file.variables, envs, null);
    assert.deepEqual(missing.missing, ["token"]);
  });

  it("fills system variables", () => {
    const file = parseHttpFile("POST http://x/{{$randomInt 5 6}}\n\n{{$guid}}");
    const { resolved } = resolveRequest(file.requests[0], {}, {}, null);
    assert.equal(resolved.url, "http://x/5");
    assert.match(resolved.body, /^[0-9a-f-]{36}$/);
  });

  it("formats a request back to .http text", () => {
    assert.equal(
      formatRequest({ name: "make", method: "POST", url: "http://x", headers: [["A", "b"]], body: "{}" }),
      "# @name make\nPOST http://x\nA: b\n\n{}",
    );
  });
});

describe("curl", () => {
  it("round-trips method, url, headers and body", () => {
    const req = { method: "POST", url: "http://localhost:3000/api?x=1", headers: [["Content-Type", "application/json"], ["X-Q", "it's"]] as [string, string][], body: '{"a":"it\'s"}' };
    assert.deepEqual(fromCurl(toCurl(req)), req);
  });

  it("reads devtools-style commands", () => {
    const cmd = `curl 'https://example.com/api' \\\n  -H 'accept: */*' \\\n  --data-raw $'{"a":1,\\n"b":2}' \\\n  --compressed`;
    assert.deepEqual(fromCurl(cmd), {
      method: "POST",
      url: "https://example.com/api",
      headers: [["accept", "*/*"]],
      body: '{"a":1,\n"b":2}',
    });
  });

  it("handles -u, -X, double quotes and non-curl text", () => {
    assert.deepEqual(shellWords(`a "b \\"c\\"" 'd e'`), ["a", 'b "c"', "d e"]);
    const r = fromCurl(`curl -X DELETE -u me:pw "http://x/1"`);
    assert.equal(r?.method, "DELETE");
    assert.deepEqual(r?.headers, [["Authorization", `Basic ${btoa("me:pw")}`]]);
    assert.equal(fromCurl("wget http://x"), null);
  });
});
