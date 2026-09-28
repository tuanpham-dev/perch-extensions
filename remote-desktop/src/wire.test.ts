import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME_HEADER_LEN, MAX_TEXT_CHARS, chunkText, clipClipboardText, parseFrame, parseFrameHeader, splitNalUnits } from "./wire.ts";

function header(fields: { frameId: number; keyframe: boolean; width: number; height: number; timestampUs: number }): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_HEADER_LEN + 3);
  const dv = new DataView(buf);
  dv.setBigUint64(0, BigInt(fields.frameId), true);
  dv.setUint32(8, fields.keyframe ? 1 : 0, true);
  dv.setUint32(12, fields.width, true);
  dv.setUint32(16, fields.height, true);
  dv.setBigUint64(20, BigInt(fields.timestampUs), true);
  return buf;
}

test("parseFrameHeader reads the little-endian layout", () => {
  const fields = { frameId: 0x0102030405, keyframe: true, width: 1920, height: 1080, timestampUs: 123456789 };
  assert.deepEqual(parseFrameHeader(header(fields)), fields);
  assert.equal(new Uint8Array(header(fields))[0], 0x05, "low byte first");
});

test("parseFrameHeader rejects short buffers", () => {
  assert.equal(parseFrameHeader(new ArrayBuffer(27)), null);
});

test("splitNalUnits keeps start codes and handles both lengths", () => {
  const bytes = new Uint8Array([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5, 6]);
  const nals = splitNalUnits(bytes);
  assert.deepEqual(
    nals.map((n) => Array.from(n)),
    [
      [0, 0, 0, 1, 0x67, 1, 2],
      [0, 0, 1, 0x68, 3],
      [0, 0, 0, 1, 0x65, 4, 5, 6],
    ],
  );
});

test("splitNalUnits returns the whole payload when no start code exists", () => {
  const nals = splitNalUnits(new Uint8Array([9, 9, 9]));
  assert.equal(nals.length, 1);
  assert.equal(splitNalUnits(new Uint8Array([])).length, 0);
});

test("clipClipboardText caps at 1 MB on a character boundary", () => {
  const short = clipClipboardText("héllo");
  assert.deepEqual(short, { text: "héllo", truncated: false });
  const long = "é".repeat(600_000); // 1.2 MB of UTF-8
  const clipped = clipClipboardText(long);
  assert.equal(clipped.truncated, true);
  assert.ok(new TextEncoder().encode(clipped.text).length <= 1024 * 1024);
  assert.ok(!clipped.text.includes("�"), "no broken sequence at the cut");
});

test("parseFrame reads the tile table and payloads", () => {
  const payloads = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  const rects = [
    { x: 0, y: 0, w: 3008, h: 1696, key: 1 },
    { x: 3008, y: 1696, w: 2992, h: 1680, key: 0 },
  ];
  const buf = new ArrayBuffer(32 + 16 * 2 + 5);
  const dv = new DataView(buf);
  dv.setBigUint64(0, 9n, true);
  dv.setUint32(12, 6000, true);
  dv.setUint32(16, 3376, true);
  dv.setUint16(28, 2, true);
  rects.forEach((r, i) => {
    const d = 32 + 16 * i;
    dv.setUint16(d, r.x, true); dv.setUint16(d + 2, r.y, true); dv.setUint16(d + 4, r.w, true); dv.setUint16(d + 6, r.h, true);
    dv.setUint32(d + 8, r.key, true); dv.setUint32(d + 12, payloads[i].length, true);
  });
  new Uint8Array(buf).set(payloads[0], 64);
  new Uint8Array(buf).set(payloads[1], 67);
  const f = parseFrame(buf);
  assert.ok(f);
  assert.equal(f.header.width, 6000);
  assert.equal(f.tiles.length, 2);
  assert.deepEqual(f.tiles[1].rect, { x: 3008, y: 1696, w: 2992, h: 1680 });
  assert.equal(f.tiles[0].keyframe, true);
  assert.deepEqual(Array.from(f.tiles[1].data), [4, 5]);
  assert.equal(parseFrame(buf.slice(0, buf.byteLength - 1)), null, "truncated payload rejected");
});

test("text splits at the per-message cap, keeping emoji whole", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("abc", 2), ["ab", "c"]);
  assert.deepEqual(chunkText("a😀b😀", 2), ["a😀", "b😀"]);
  const long = "x".repeat(10_000);
  const parts = chunkText(long);
  assert.deepEqual(parts.map((p) => p.length), [MAX_TEXT_CHARS, MAX_TEXT_CHARS, 10_000 - 2 * MAX_TEXT_CHARS]);
  assert.equal(parts.join(""), long);
});
