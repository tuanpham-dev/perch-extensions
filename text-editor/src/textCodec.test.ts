import assert from "node:assert/strict";
import { it } from "node:test";
import { decodeBytes, encodeText } from "./textCodec.ts";
import { checkDiskConflict } from "./diskConflict.ts";

const bytes = (...b: number[]) => new Uint8Array(b);

it("reads plain UTF-8 and writes it back unchanged", () => {
  const src = new TextEncoder().encode("café ✓\n");
  const { text, encoding } = decodeBytes(src);
  assert.equal(text, "café ✓\n");
  assert.deepEqual(encoding, { charset: "utf-8", bom: false });
  assert.deepEqual(encodeText(text, encoding), src);
});

it("keeps a UTF-8 byte-order mark out of the text and puts it back on save", () => {
  const src = bytes(0xef, 0xbb, 0xbf, 0x68, 0x69);
  const { text, encoding } = decodeBytes(src);
  assert.equal(text, "hi");
  assert.deepEqual(encoding, { charset: "utf-8", bom: true });
  assert.deepEqual(encodeText(text, encoding), src);
  assert.deepEqual(encodeText(text + "!", encoding), bytes(0xef, 0xbb, 0xbf, 0x68, 0x69, 0x21));
});

it("reads non-UTF-8 as Latin-1 and round-trips every byte", () => {
  // "café" in Latin-1, plus the 0x80-0x9f range windows-1252 would remap.
  const src = bytes(0x63, 0x61, 0x66, 0xe9, 0x80, 0x93, 0x9f, 0xff, 0x0a);
  const { text, encoding } = decodeBytes(src);
  assert.equal(encoding.charset, "latin1");
  assert.equal(text.slice(0, 4), "café");
  assert.deepEqual(encodeText(text, encoding), src);
  // All 256 byte values.
  const all = new Uint8Array(256).map((_, i) => i);
  const decoded = decodeBytes(all);
  assert.equal(decoded.encoding.charset, "latin1");
  assert.deepEqual(encodeText(decoded.text, decoded.encoding), all);
});

it("refuses to save a character Latin-1 can't hold", () => {
  assert.throws(() => encodeText("café ✓", { charset: "latin1", bom: false }), /Latin-1/);
});

it("handles an empty file and a large Latin-1 file", () => {
  assert.deepEqual(decodeBytes(new Uint8Array(0)), { text: "", encoding: { charset: "utf-8", bom: false } });
  const big = new Uint8Array(300_000).map((_, i) => (i % 2 ? 0xe9 : 0x41));
  const { text, encoding } = decodeBytes(big);
  assert.equal(text.length, big.length);
  assert.deepEqual(encodeText(text, encoding), big);
});

it("asks Overwrite / Reload / Cancel only when the disk text changed", async () => {
  let asked: { title: string; items: { id: string; label: string; detail?: string }[] } | null = null;
  const pick = async (opts: typeof asked & object) => {
    asked = opts;
    return "reload";
  };
  assert.equal(await checkDiskConflict({ name: "a.txt", loaded: "x", readDisk: async () => "x", pick }), "none");
  assert.equal(asked, null);
  assert.equal(await checkDiskConflict({ name: "a.txt", loaded: "x", readDisk: async () => "y", pick }), "reload");
  assert.equal(asked!.title, "a.txt changed on disk since you opened it.");
  assert.deepEqual(
    asked!.items.map((i) => [i.label, i.detail]),
    [
      ["Overwrite", "Save your version over the changes on disk"],
      ["Reload", "Take the version on disk; your unsaved changes are lost"],
      ["Cancel", "Don't save"],
    ],
  );
  // Dismissed: cancel. Gone from disk: nothing to ask. No picker: overwrite, as before.
  assert.equal(await checkDiskConflict({ name: "a", loaded: "x", readDisk: async () => "y", pick: async () => null }), "cancel");
  assert.equal(await checkDiskConflict({ name: "a", loaded: "x", readDisk: () => Promise.reject(new Error("404")), pick }), "none");
  assert.equal(await checkDiskConflict({ name: "a", loaded: "x", readDisk: async () => "y", pick: undefined }), "overwrite");
});
