// Runs under `node --test --experimental-strip-types` (see package.json's
// test script). The fixture is real `git blame --porcelain` output shape:
// three commits, one of them appearing twice (metadata only on the first
// appearance), and one uncommitted line.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBlamePorcelain } from "./blameModel.ts";

const FIXTURE = [
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 2",
  "author Ada",
  "author-mail <ada@example.com>",
  "author-time 1700000000",
  "author-tz +0000",
  "summary Add the header",
  "filename app.js",
  "\timport fs from 'node:fs';",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2 2",
  "\timport path from 'node:path';",
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 5 3 1",
  "author Grace",
  "author-time 1700009999",
  "summary Wire the server",
  "filename app.js",
  "\tconst app = createApp();",
  "0000000000000000000000000000000000000000 4 4 1",
  "author Not Committed Yet",
  "author-time 1700010500",
  "summary Version of app.js from app.js",
  "filename app.js",
  "\tconst draft = true;",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 3 5",
  "\texport default app;",
  "",
].join("\n");

describe("parseBlamePorcelain", () => {
  const blame = parseBlamePorcelain(FIXTURE);

  it("returns one entry per content line", () => {
    assert.equal(blame.lines.length, 5);
    assert.deepEqual(
      blame.lines.map((l) => l.content),
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const app = createApp();",
        "const draft = true;",
        "export default app;",
      ],
    );
  });

  it("numbers lines from the blamed revision", () => {
    assert.deepEqual(
      blame.lines.map((l) => l.lineNo),
      [1, 2, 3, 4, 5],
    );
  });

  it("carries a commit's metadata forward to its later lines", () => {
    // Line 2 repeats commit aaaa with the hash alone.
    assert.equal(blame.lines[1].author, "Ada");
    assert.equal(blame.lines[1].summary, "Add the header");
    assert.equal(blame.lines[1].timestamp, 1700000000);
    // And so does line 5, after two other commits in between.
    assert.equal(blame.lines[4].author, "Ada");
    assert.equal(blame.lines[4].summary, "Add the header");
  });

  it("reads each commit's own metadata", () => {
    assert.equal(blame.lines[2].author, "Grace");
    assert.equal(blame.lines[2].summary, "Wire the server");
    assert.equal(blame.lines[2].timestamp, 1700009999);
  });

  it("marks the all-zero hash as uncommitted", () => {
    assert.equal(blame.lines[3].uncommitted, true);
    assert.equal(blame.lines[0].uncommitted, false);
  });

  it("groups consecutive lines of one commit into runs", () => {
    assert.deepEqual(
      blame.runs.map((r) => [r.hash.slice(0, 4), r.start, r.end]),
      [
        ["aaaa", 0, 1],
        ["bbbb", 2, 2],
        ["0000", 3, 3],
        ["aaaa", 4, 4],
      ],
    );
  });

  it("keeps a tab-indented source line's own indentation", () => {
    const indented = parseBlamePorcelain(
      ["cccccccccccccccccccccccccccccccccccccccc 1 1 1", "author X", "author-time 1", "summary s", "\t\tindented();"].join(
        "\n",
      ),
    );
    assert.equal(indented.lines[0].content, "\tindented();");
  });

  it("returns nothing for empty output", () => {
    assert.deepEqual(parseBlamePorcelain(""), { lines: [], runs: [] });
  });
});
