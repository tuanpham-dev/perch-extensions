// The backup layer between the editor's models and the host's drafts store.
// What models.ts relies on: requests for one file reach the server in issue
// order (a slow write must not land after the delete that followed a save),
// a read waits for that file's pending writes, junk in the store reads as no
// backup, and a host without ctx.drafts makes every call a quiet no-op.
import { strict as assert } from "node:assert";
import { test } from "node:test";

const { setDraftsApi, readBackup, writeBackup, clearBackup, hashText } = await import("./unsavedBackup.ts");

// A drafts store whose requests settle only when the test says so, recording
// the order the server would have applied them in.
function fakeDrafts() {
  const store = new Map<string, unknown>();
  const applied: string[] = [];
  const gates: (() => void)[] = [];
  const gate = () => new Promise<void>((resolve) => gates.push(resolve));
  const api = {
    async get(key: string) {
      return store.has(key) ? { value: store.get(key), savedAt: 0 } : null;
    },
    async set(key: string, value: unknown) {
      await gate();
      store.set(key, value);
      applied.push(`set ${(value as { text: string }).text}`);
    },
    async delete(key: string) {
      await gate();
      store.delete(key);
      applied.push("delete");
    },
  };
  const releaseAll = async () => {
    // Each release lets one queued request run, which then waits on its own gate.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 0));
      gates.splice(0).forEach((g) => g());
    }
  };
  return { api, store, applied, releaseAll };
}

test("requests for one file apply in issue order", async () => {
  const fake = fakeDrafts();
  setDraftsApi(fake.api);
  writeBackup("/a.ts", "one", "disk");
  writeBackup("/a.ts", "two", "disk");
  clearBackup("/a.ts");
  await fake.releaseAll();
  assert.deepEqual(fake.applied, ["set one", "set two", "delete"]);
  assert.equal(fake.store.has("/a.ts"), false);
});

test("a read waits for the file's pending writes", async () => {
  const fake = fakeDrafts();
  setDraftsApi(fake.api);
  writeBackup("/b.ts", "edited", "disk");
  const read = readBackup("/b.ts");
  await fake.releaseAll();
  assert.deepEqual(await read, { text: "edited", base: hashText("disk") });
});

test("a malformed stored value, or a failing store, reads as no backup", async () => {
  const fake = fakeDrafts();
  setDraftsApi(fake.api);
  fake.store.set("/c.ts", { text: 42 });
  assert.equal(await readBackup("/c.ts"), null);

  setDraftsApi({
    get: async () => {
      throw new Error("offline");
    },
    set: async () => {},
    delete: async () => {},
  });
  assert.equal(await readBackup("/c.ts"), null);
});

test("without a drafts API every call is a no-op", async () => {
  setDraftsApi(null);
  writeBackup("/d.ts", "x", "y");
  clearBackup("/d.ts");
  assert.equal(await readBackup("/d.ts"), null);
});

test("hashText tells different baselines apart", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
  assert.notEqual(hashText(""), hashText("a"));
});
