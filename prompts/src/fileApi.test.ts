import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { fetchFileText, NotFoundError } from "./fileApi.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Answers the download route with `download`, and the folder listing with
// `listing` (or a 400 when it's a string: that error message).
function fakeHost(download: { status: number; body?: unknown }, listing: string[] | string) {
  globalThis.fetch = (async (input: string) => {
    const url = String(input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("/api/download")) {
      if (download.status === 200) return new Response(String(download.body), { status: 200 });
      return json(download.status, download.body ?? { error: "x" });
    }
    if (url.startsWith("/api/fs?")) {
      if (typeof listing === "string") return json(400, { error: listing });
      return json(200, { path: "/p", entries: listing.map((name) => ({ name, dir: false })) });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

it("reads a file", async () => {
  fakeHost({ status: 200, body: "hello" }, []);
  assert.equal(await fetchFileText("/p/a.prompt.md"), "hello");
});

it("treats a 404 as a new file", async () => {
  fakeHost({ status: 404 }, ["a.prompt.md"]);
  await assert.rejects(fetchFileText("/p/a.prompt.md"), NotFoundError);
});

it("treats a 400 as a new file only when the folder doesn't list it", async () => {
  fakeHost({ status: 400, body: { error: "path is not a file or directory" } }, ["other.md"]);
  await assert.rejects(fetchFileText("/p/a.prompt.md"), NotFoundError);
  fakeHost({ status: 400, body: { error: "path is not a file or directory" } }, "path is not a directory");
  await assert.rejects(fetchFileText("/p/a.prompt.md"), NotFoundError);
});

it("never calls a forced 400 on an existing file 'new'", async () => {
  fakeHost({ status: 400, body: { error: "EACCES: permission denied" } }, ["a.prompt.md"]);
  await assert.rejects(fetchFileText("/p/a.prompt.md"), (err: Error) => !(err instanceof NotFoundError) && /EACCES/.test(err.message));
  fakeHost({ status: 400, body: { error: "path is not a file or directory" } }, ["a.prompt.md"]);
  await assert.rejects(fetchFileText("/p/a.prompt.md"), (err: Error) => !(err instanceof NotFoundError));
  // The folder can't be listed either: still not "new".
  fakeHost({ status: 400, body: { error: "boom" } }, "EACCES: permission denied");
  await assert.rejects(fetchFileText("/p/a.prompt.md"), (err: Error) => !(err instanceof NotFoundError));
});

it("reports a server error as an error, not a new file", async () => {
  fakeHost({ status: 500, body: { error: "disk on fire" } }, []);
  await assert.rejects(fetchFileText("/p/a.prompt.md"), (err: Error) => !(err instanceof NotFoundError) && /disk on fire/.test(err.message));
});
