import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryStorage } from "../../scripts/memoryStorage.mjs";
import { BODY_LIMIT_MESSAGE, cleanLayout, createNotesStore, movedPath } from "../store.mjs";

describe("notes store", () => {
  it("creates, patches and deletes", async () => {
    const { storage } = createMemoryStorage();
    const store = createNotesStore(storage);
    const note = await store.create({ scope: "project", projectPath: "~/app", body: "Release checklist" }, 1);
    assert.equal(note.body, "Release checklist");
    const patched = await store.patch(note.id, { body: "Edited", scope: "file", id: "x" }, 2);
    assert.equal(patched.body, "Edited");
    assert.equal(patched.scope, "project");
    assert.equal(patched.id, note.id);
    assert.equal(patched.updatedAt, 2);
    assert.equal(await store.patch("missing", { body: "x" }), null);
    assert.equal(await store.remove(note.id), true);
    assert.equal(await store.remove(note.id), false);
    assert.deepEqual(await store.all(), []);
  });

  it("keeps one record per note, so each change is announced on its own", async () => {
    const { storage, events } = createMemoryStorage();
    const store = createNotesStore(storage);
    const a = await store.create({ scope: "window", projectPath: "~/app", windowId: "w7", body: "x" });
    await store.patch(a.id, { body: "y" });
    const keys = events.filter((e) => e.type === "change").map((e) => `${e.collection}:${e.changes.map((c: { key: string }) => c.key)}`);
    assert.deepEqual(keys, [`notes:${a.id}`, `notes:${a.id}`]);
    const again = await createNotesStore(storage).all();
    assert.equal(again[0].windowId, "w7");
  });

  it("refuses an oversized body written from a browser", () => {
    const mem = createMemoryStorage();
    createNotesStore(mem.storage);
    assert.equal(mem.validate("notes", "n", { body: "x".repeat(256 * 1024 + 1) }), BODY_LIMIT_MESSAGE);
    assert.equal(mem.validate("notes", "n", { body: "fine" }), null);
  });

  it("moves file notes with a rename, including notes inside a moved folder", async () => {
    const store = createNotesStore(createMemoryStorage().storage);
    const a = await store.create({ scope: "file", projectPath: "~/app", filePath: "/r/src/api.ts", body: "" });
    const b = await store.create({ scope: "file", projectPath: "~/app", filePath: "/r/src/lib/x.ts", body: "" });
    const c = await store.create({ scope: "file", projectPath: "~/app", filePath: "/r/srcx/y.ts", body: "" });
    const moved = await store.renameFiles([
      { from: "/r/src/api.ts", to: "/r/src/server.ts" },
      { from: "/r/src/lib", to: "/r/lib" },
    ]);
    assert.equal(moved, 2);
    const byId = Object.fromEntries((await store.all()).map((n: { id: string; filePath: string }) => [n.id, n.filePath]));
    assert.equal(byId[a.id], "/r/src/server.ts");
    assert.equal(byId[b.id], "/r/lib/x.ts");
    assert.equal(byId[c.id], "/r/srcx/y.ts");
  });

  it("doesn't treat a sibling with a shared prefix as inside a folder", () => {
    assert.equal(movedPath("/r/srcx/y.ts", "/r/src", "/r/lib"), null);
    assert.equal(movedPath("/r/src", "/r/src", "/r/lib"), "/r/lib");
  });

  it("keeps a card's colour, box and hidden flag without counting them as edits", async () => {
    const store = createNotesStore(createMemoryStorage().storage);
    const note = await store.create({ scope: "window", projectPath: "~/app", windowId: "w1", body: "x" }, 1);
    const p = await store.patch(note.id, { color: "green", layout: { x: 0.9, y: -1, w: 0.3, h: 0.2 }, hidden: true }, 5);
    assert.equal(p.color, "green");
    assert.deepEqual(p.layout, { x: 0.7, y: 0, w: 0.3, h: 0.2 });
    assert.equal(p.hidden, true);
    assert.equal(p.updatedAt, 1);
    assert.equal((await store.patch(note.id, { color: "neon" })).color, "green");
    assert.equal(await store.unhide([note.id]), 1);
    assert.equal((await store.all())[0].hidden, undefined);
  });

  it("records hidden terminals and files", async () => {
    const store = createNotesStore(createMemoryStorage().storage);
    await store.setSurfaceHidden("window:w1", true);
    assert.deepEqual(await store.surfaces(), { "window:w1": { hidden: true } });
    await store.setSurfaceHidden("window:w1", false);
    assert.deepEqual(await store.surfaces(), {});
  });

  it("clamps a box into the area and refuses junk", () => {
    assert.deepEqual(cleanLayout({ x: 0.5, y: 0.5, w: 2, h: 0.01 }), { x: 0, y: 0.5, w: 1, h: 0.05 });
    assert.equal(cleanLayout({ x: "a" }), null);
    assert.equal(cleanLayout(null), null);
  });
});
