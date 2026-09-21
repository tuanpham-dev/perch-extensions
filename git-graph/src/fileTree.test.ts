// An expanded commit's file rows, in both views. Runs under
// `node --test --experimental-strip-types` (see package.json).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileRows } from "./fileTree.ts";

const f = (path: string) => ({ path });
const shape = (rows: ReturnType<typeof fileRows<{ path: string }>>) =>
  rows.map((r) => `${"  ".repeat(r.depth)}${r.kind === "dir" ? `${r.name}/` : r.name}`);

describe("fileRows", () => {
  it("keeps the list view as the paths, in the order given", () => {
    const rows = fileRows([f("b.txt"), f("src/a.ts")], "list");
    assert.deepEqual(shape(rows), ["b.txt", "src/a.ts"]);
  });

  it("groups a tree by folder, folders before files", () => {
    const rows = fileRows([f("z.txt"), f("src/b.ts"), f("src/a.ts"), f("docs/x.md")], "tree");
    assert.deepEqual(shape(rows), ["docs/", "  x.md", "src/", "  a.ts", "  b.ts", "z.txt"]);
  });

  it("joins a chain of single-folder folders into one row", () => {
    const rows = fileRows([f("client/src/components/Tab.tsx"), f("client/src/components/Bar.tsx")], "tree");
    assert.deepEqual(shape(rows), ["client/src/components/", "  Bar.tsx", "  Tab.tsx"]);
    const dir = rows[0];
    assert.equal(dir.kind, "dir");
    assert.equal(dir.kind === "dir" && dir.path, "client/src/components", "the key is the deepest folder's path");
  });

  it("stops joining at a folder that has files of its own", () => {
    const rows = fileRows([f("src/index.ts"), f("src/lib/util.ts")], "tree");
    assert.deepEqual(shape(rows), ["src/", "  lib/", "    util.ts", "  index.ts"]);
  });

  it("hides a collapsed folder's contents and counts them", () => {
    const rows = fileRows([f("src/a.ts"), f("src/lib/b.ts"), f("top.txt")], "tree", new Set(["src"]));
    assert.deepEqual(shape(rows), ["src/", "top.txt"]);
    const dir = rows[0];
    assert.ok(dir.kind === "dir" && dir.collapsed);
    assert.equal(dir.kind === "dir" && dir.fileCount, 2);
  });

  it("returns no rows for no files", () => {
    assert.deepEqual(fileRows([], "tree"), []);
    assert.deepEqual(fileRows([], "list"), []);
  });
});
