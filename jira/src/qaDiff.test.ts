// The QA branch's Changes view: which commits and edits make up a ticket's
// diff, and how the text is read back into files and lines.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildQaDiff, capPatch, untrackedPatch } from "../qaDiff.mjs";
import { diffTotals, parseUnifiedDiff } from "../diffModel.mjs";

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-qadiff-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
  run("init", "-q", "-b", "main");
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = (message: string) => {
    run("add", "-A");
    run("commit", "-q", "-m", message);
    return run("rev-parse", "HEAD").trim();
  };
  const git = async (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const readFile = (file: string) => fs.promises.readFile(path.join(dir, file));
  return { dir, write, commit, git, readFile, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function filesOf(section: { patch: string }) {
  return parseUnifiedDiff(section.patch).map((f) => `${f.status} ${f.path} +${f.additions} -${f.deletions}`);
}

test("a merged ticket shows its own commit against the one before it", async () => {
  const r = repo();
  try {
    r.write("a.txt", "one\n");
    const base = r.commit("base");
    r.write("a.txt", "one\ntwo\n");
    const ticket = r.commit("CAP-1");
    r.write("b.txt", "later\n");
    r.commit("CAP-2");
    r.write("a.txt", "one\ntwo\nuncommitted\n");

    const diff = await buildQaDiff({ git: r.git, cwd: r.dir, commit: ticket, withUncommitted: false, readFile: r.readFile });
    assert.equal(diff.base, base.slice(0, 7));
    assert.equal(diff.combined, false);
    assert.equal(diff.sections.length, 1);
    // Neither the later ticket nor the working tree leaks in.
    assert.deepEqual(filesOf(diff.sections[0]), ["modified a.txt +1 -0"]);
  } finally {
    r.done();
  }
});

test("a ticket being fixed at the tip reads as one diff, uncommitted and untracked included", async () => {
  const r = repo();
  try {
    r.write("a.txt", "one\n");
    r.commit("base");
    r.write("a.txt", "one\ntwo\n");
    const ticket = r.commit("CAP-1");
    r.write("a.txt", "one\ntwo\nthree\n");
    r.write("src/new.txt", "fresh");

    const diff = await buildQaDiff({ git: r.git, cwd: r.dir, commit: ticket, withUncommitted: true, readFile: r.readFile });
    assert.equal(diff.combined, true);
    assert.equal(diff.sections.length, 1);
    assert.deepEqual(filesOf(diff.sections[0]), ["modified a.txt +2 -0", "added src/new.txt +1 -0"]);
    const added = parseUnifiedDiff(diff.sections[0].patch)[1];
    assert.equal(added.hunks[0].lines.at(-1)?.kind, "note");
  } finally {
    r.done();
  }
});

test("a ticket being fixed under a later one keeps its commit and the edits apart", async () => {
  const r = repo();
  try {
    r.write("a.txt", "one\n");
    r.commit("base");
    r.write("a.txt", "one\ntwo\n");
    const ticket = r.commit("CAP-1");
    r.write("b.txt", "later\n");
    r.commit("CAP-2");
    r.write("a.txt", "one\ntwo\nthree\n");

    const diff = await buildQaDiff({ git: r.git, cwd: r.dir, commit: ticket, withUncommitted: true, readFile: r.readFile });
    assert.equal(diff.combined, false);
    assert.deepEqual(
      diff.sections.map((s: { label: string }) => s.label),
      ["Committed", "Uncommitted"],
    );
    assert.deepEqual(filesOf(diff.sections[0]), ["modified a.txt +1 -0"]);
    assert.deepEqual(filesOf(diff.sections[1]), ["modified a.txt +1 -0"]);
  } finally {
    r.done();
  }
});

test("a root commit diffs against the empty tree", async () => {
  const r = repo();
  try {
    r.write("a.txt", "one\n");
    const root = r.commit("root");
    const diff = await buildQaDiff({ git: r.git, cwd: r.dir, commit: root, withUncommitted: false, readFile: r.readFile });
    assert.equal(diff.base, "");
    assert.deepEqual(filesOf(diff.sections[0]), ["added a.txt +1 -0"]);
  } finally {
    r.done();
  }
});

test("a commit the worktree no longer has is a conflict, not a crash", async () => {
  const r = repo();
  try {
    r.write("a.txt", "one\n");
    r.commit("root");
    await assert.rejects(
      buildQaDiff({ git: r.git, cwd: r.dir, commit: "deadbeef", withUncommitted: false, readFile: r.readFile }),
      (err: { status?: number }) => err.status === 409,
    );
  } finally {
    r.done();
  }
});

test("renames, deletions and binaries are told apart", () => {
  const files = parseUnifiedDiff(
    [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -3,2 +3,2 @@ function x() {",
      " keep",
      "-gone",
      "+came",
      "diff --git a/dead.txt b/dead.txt",
      "deleted file mode 100644",
      "--- a/dead.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    files.map((f) => [f.status, f.path, f.oldPath, f.binary]),
    [
      ["renamed", "new.ts", "old.ts", false],
      ["deleted", "dead.txt", "dead.txt", false],
      ["modified", "img.png", "img.png", true],
    ],
  );
  const lines = files[0].hunks[0].lines;
  assert.equal(files[0].hunks[0].section, "function x() {");
  assert.deepEqual(
    lines.map((l) => [l.kind, l.oldNo, l.newNo]),
    [
      ["ctx", 3, 3],
      ["del", 4, null],
      ["add", null, 4],
    ],
  );
  assert.deepEqual(diffTotals(files), { files: 3, additions: 1, deletions: 2 });
});

test("an untracked file is written as git would add it", () => {
  assert.equal(
    untrackedPatch("x.txt", "a\nb\n"),
    "diff --git a/x.txt b/x.txt\nnew file mode 100644\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n",
  );
  assert.match(untrackedPatch("x.bin", null), /Binary files/);
});

test("a patch past the cap is cut at a file boundary", () => {
  const one = "diff --git a/a b/a\n@@ -1 +1 @@\n-x\n+y\n";
  const { patch, truncated } = capPatch(one + one + one, one.length * 2 - 5);
  assert.equal(truncated, true);
  assert.equal(patch, one);
});
