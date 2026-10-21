import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { activate, parseLineRange, parseLog } from "../server.js";
import { matchesFilter } from "./historyModel.ts";

describe("history helpers", () => {
  it("reads a line range", () => {
    assert.deepEqual(parseLineRange("10,20"), { start: 10, end: 20 });
    assert.deepEqual(parseLineRange(" 3 , 3 "), { start: 3, end: 3 });
    assert.equal(parseLineRange("0,4"), null);
    assert.equal(parseLineRange("9,4"), null);
    assert.equal(parseLineRange("1,2:/etc/passwd"), null);
  });

  it("parses log records with and without name-status", () => {
    const raw = "\x1eaaa\x1fAnn\x1f100\x1fFirst\n\nR090\told.ts\tnew.ts\n\x1ebbb\x1fBob\x1f90\x1fSecond\n\nM\told.ts\n";
    assert.deepEqual(parseLog(raw, "new.ts"), [
      { hash: "aaa", author: "Ann", timestamp: 100, subject: "First", status: "R", path: "new.ts", oldPath: "old.ts" },
      { hash: "bbb", author: "Bob", timestamp: 90, subject: "Second", status: "M", path: "old.ts", oldPath: null },
    ]);
    // A line-range log: the path asked about, and any patch text ignored.
    const ranged = parseLog("\x1eccc\x1fCy\x1f80\x1fThird\n\ndiff --git a/x b/x\n@@ -1 +1 @@\n", "x");
    assert.equal(ranged[0].path, "x");
    assert.equal(ranged[0].subject, "Third");
  });

  it("filters by subject, author or SHA prefix", () => {
    const c = { hash: "abc123", subject: "Fix the parser", author: "Ann Lee" };
    assert.ok(matchesFilter(c, "PARSER"));
    assert.ok(matchesFilter(c, "ann"));
    assert.ok(matchesFilter(c, "abc1"));
    assert.ok(!matchesFilter(c, "c123"));
    assert.ok(matchesFilter(c, "  "));
  });
});

// The /history route against a throwaway repository: paging past 500 and
// the history of a line range.
describe("/history route", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gh-history-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("config", "commit.gpgsign", "false");
  // 520 commits to f.txt: each rewrites line 1; commit 7 also edits line 3.
  const lines = ["a", "b", "c", "d", "e"];
  for (let i = 1; i <= 520; i++) {
    lines[0] = `one ${i}`;
    if (i === 7) lines[2] = "c changed";
    writeFileSync(path.join(dir, "f.txt"), `${lines.join("\n")}\n`);
    git("add", "f.txt");
    git("commit", "-q", "-m", `commit ${i}`);
  }

  const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  activate({ router: { get: (p: string, h: never) => routes.set(p, h), post: () => {} } });
  const call = async (query: Record<string, string>) => {
    let status = 200;
    let body: { commits: { subject: string }[]; hasMore: boolean; error?: string } | null = null;
    const res = {
      status(s: number) {
        status = s;
        return res;
      },
      json(b: typeof body) {
        body = b;
      },
    };
    await routes.get("/history")!({ query: { cwd: dir, path: "f.txt", ...query } }, res);
    return { status, body: body! };
  };

  it("pages with skip past 500 commits", async () => {
    const first = await call({ limit: "500" });
    assert.equal(first.body.commits.length, 500);
    assert.equal(first.body.hasMore, true);
    const rest = await call({ limit: "50", skip: "500" });
    assert.equal(rest.body.commits.length, 20);
    assert.equal(rest.body.hasMore, false);
    assert.equal(rest.body.commits.at(-1)!.subject, "commit 1");
  });

  it("lists only the commits that changed a line range", async () => {
    const r = await call({ lines: "3,3" });
    assert.deepEqual(r.body.commits.map((c) => c.subject), ["commit 7", "commit 1"]);
    const bad = await call({ lines: "3" });
    assert.equal(bad.status, 400);
  });
});
