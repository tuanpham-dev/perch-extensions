import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { ensurePrivateDir, pickRuntimeDir } from "../runtimeDir.mjs";

const uid = process.getuid!();
const root = await mkdtemp(path.join(os.tmpdir(), "gui-rt-"));
after(() => rm(root, { recursive: true, force: true }));

it("uses $XDG_RUNTIME_DIR/perch-gui when it exists, else a /tmp folder", async () => {
  assert.equal(await pickRuntimeDir({ XDG_RUNTIME_DIR: root }, uid), path.join(root, "perch-gui"));
  assert.equal(await pickRuntimeDir({}, uid), `/tmp/perch-gui-${uid}`);
  assert.equal(await pickRuntimeDir({ XDG_RUNTIME_DIR: path.join(root, "missing") }, uid), `/tmp/perch-gui-${uid}`);
  assert.equal(await pickRuntimeDir({ XDG_RUNTIME_DIR: "relative" }, uid), `/tmp/perch-gui-${uid}`);
  // Too long for xpra's socket path to fit.
  const deep = path.join(root, "x".repeat(80));
  await mkdir(deep);
  assert.equal(await pickRuntimeDir({ XDG_RUNTIME_DIR: deep }, uid), `/tmp/perch-gui-${uid}`);
});

it("creates the folder 0700 and accepts it again", async () => {
  const dir = path.join(root, "fresh");
  assert.equal(await ensurePrivateDir(dir, uid), dir);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal(await ensurePrivateDir(dir, uid), dir);
});

it("refuses a folder with looser permissions", async () => {
  const dir = path.join(root, "loose");
  await mkdir(dir);
  await chmod(dir, 0o755);
  await assert.rejects(ensurePrivateDir(dir, uid), /mode 755/);
});

it("refuses a folder owned by someone else", async () => {
  const dir = path.join(root, "theirs");
  await mkdir(dir, { mode: 0o700 });
  // Checked against a different uid, as if another user had made it first.
  await assert.rejects(ensurePrivateDir(dir, uid + 1), /another user/);
});

it("refuses a link or a file in its place", async () => {
  const target = path.join(root, "target");
  await mkdir(target, { mode: 0o700 });
  const link = path.join(root, "link");
  await symlink(target, link);
  await assert.rejects(ensurePrivateDir(link, uid), /not a plain folder/);
  const file = path.join(root, "file");
  await writeFile(file, "");
  await assert.rejects(ensurePrivateDir(file, uid), /not a plain folder/);
});
