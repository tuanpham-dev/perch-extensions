import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Channel,
  FRAME_META_LEN,
  MAX_TEXT_CHARS,
  chunkText,
  clipClipboardText,
  codecString,
  decodeFileChunk,
  decodeSeatMessage,
  encodeFileChunk,
  encodeSeatMessage,
  parseVideo,
  wrap,
} from "./wire.ts";

function video(fields: { stream: number; codec: number; flags: number; width: number; height: number; au: number[] }): Uint8Array {
  const buf = new Uint8Array(1 + FRAME_META_LEN + fields.au.length);
  const dv = new DataView(buf.buffer);
  buf[0] = fields.stream;
  buf[1] = fields.codec;
  buf[2] = fields.flags;
  dv.setUint16(3, fields.width, true);
  dv.setUint16(5, fields.height, true);
  dv.setUint32(7, fields.au.length, true);
  dv.setBigUint64(11, 1000n, true);
  dv.setBigUint64(19, 1100n, true);
  dv.setBigUint64(27, 1200n, true);
  dv.setBigUint64(35, 1300n, true);
  buf.set(fields.au, 1 + FRAME_META_LEN);
  return buf;
}

test("parseVideo reads the stream byte, FrameMeta and the access unit", () => {
  const f = parseVideo(video({ stream: 0, codec: 1, flags: 1, width: 1920, height: 1080, au: [0, 0, 1, 0x67, 9] }));
  assert.ok(f);
  assert.equal(f.stream, 0);
  assert.equal(f.keyframe, true);
  assert.deepEqual(
    { ...f.meta },
    { codec: 1, flags: 1, width: 1920, height: 1080, len: 5, captureUs: 1000n, encodeStartUs: 1100n, encodeEndUs: 1200n, sendUs: 1300n },
  );
  assert.deepEqual(Array.from(f.au), [0, 0, 1, 0x67, 9]);
});

test("parseVideo rejects short or inconsistent payloads", () => {
  assert.equal(parseVideo(new Uint8Array(FRAME_META_LEN)), null);
  const buf = video({ stream: 0, codec: 1, flags: 0, width: 8, height: 8, au: [1, 2, 3] });
  assert.equal(parseVideo(buf.subarray(0, buf.length - 1)), null, "the access unit must be as long as `len` says");
});

test("seat messages round-trip", () => {
  const seat = { t: "Seat" as const, driver: false, scalePct: 200, driverRatioPct: 150, viewers: 3, cursorInPicture: true };
  assert.deepEqual(decodeSeatMessage(encodeSeatMessage(seat)), seat);
  const claim = { t: "Claim" as const, viewerId: "perch-7f3a" };
  const bytes = encodeSeatMessage(claim);
  assert.equal(bytes[0], 2);
  assert.deepEqual(decodeSeatMessage(bytes), claim);
  assert.throws(() => decodeSeatMessage(new Uint8Array([9])));
});

test("file chunks round-trip and wrap puts the channel first", () => {
  const chunk = { id: 7, last: true, data: new Uint8Array([1, 2, 3]) };
  const bytes = encodeFileChunk(chunk);
  assert.deepEqual(Array.from(bytes), [7, 0, 0, 0, 1, 1, 2, 3]);
  const back = decodeFileChunk(bytes);
  assert.equal(back.id, 7);
  assert.equal(back.last, true);
  assert.deepEqual(Array.from(back.data), [1, 2, 3]);
  const wrapped = wrap(Channel.FILE, bytes);
  assert.equal(wrapped[0], 4);
  assert.equal(wrapped.length, bytes.length + 1);
});

test("codecString reads the H.264 SPS profile, level and constraints", () => {
  const au = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x33, 0xac]);
  assert.equal(codecString(1, au), "avc1.640033");
  assert.equal(codecString(1, new Uint8Array([0, 0, 1, 0x65, 1, 2, 3, 4])), "avc1.640033", "no SPS: the default");
  assert.equal(codecString(2, au), "hev1.1.6.L153.B0");
  assert.equal(codecString(3, au), "av01.0.08M.08");
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
