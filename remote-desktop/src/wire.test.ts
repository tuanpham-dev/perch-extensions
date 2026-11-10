import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TEXT_CHARS, chunkText, clipClipboardText, codecString } from "./wire.ts";

test("codecString reads the H.264 SPS profile, level and constraints", () => {
  const au = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x33, 0xac]);
  assert.equal(codecString(1, au), "avc1.640033");
  assert.equal(codecString(1, new Uint8Array([0, 0, 1, 0x65, 1, 2, 3, 4])), "avc1.640033", "no SPS: the default");
  assert.equal(codecString(2, au), "hev1.1.6.L153.B0");
});

test("clipClipboardText caps at 16 MB on a character boundary", () => {
  const short = clipClipboardText("héllo");
  assert.deepEqual(short, { text: "héllo", truncated: false });
  const long = "é".repeat(9_000_000); // 18 MB of UTF-8
  const clipped = clipClipboardText(long);
  assert.equal(clipped.truncated, true);
  assert.ok(new TextEncoder().encode(clipped.text).length <= 16 * 1024 * 1024);
  assert.ok(!clipped.text.includes("�"), "no broken sequence at the cut");
});

test("text splits at the per-event cap, keeping emoji whole", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("abc", 2), ["ab", "c"]);
  assert.deepEqual(chunkText("a😀b😀", 2), ["a😀", "b😀"]);
  const long = "x".repeat(10_000);
  const parts = chunkText(long);
  assert.deepEqual(parts.map((p) => p.length), [MAX_TEXT_CHARS, MAX_TEXT_CHARS, 10_000 - 2 * MAX_TEXT_CHARS]);
  assert.equal(parts.join(""), long);
});
