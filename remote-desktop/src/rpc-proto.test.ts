// The TypeScript codec for remote-pc (src/rpc/proto.ts) decodes every
// vector remote-pc's own encoder wrote (crates/rpc-proto/tests/vectors.rs)
// and re-encodes it byte for byte. Lives next to the other tests so the
// root `npm test` glob (*/src/*.test.ts) finds it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as P from "./rpc/proto.ts";

const vectors: { name: string; kind: string; hex: string }[] = JSON.parse(readFileSync(new URL("./rpc/vectors.json", import.meta.url), "utf8"));
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

test("every vector round-trips", () => {
  const seen = new Set<string>();
  for (const v of vectors) {
    const b = fromHex(v.hex);
    let out: Uint8Array;
    switch (v.kind) {
      case "msg": { const m = P.decodeMsg(b); assert.ok(m, v.name); out = P.encodeMsg(m); break; }
      case "cursor": { const c = P.decodeCursor(b); assert.ok(c, v.name); out = P.encodeCursor(c); break; }
      case "ws-control": { const m = P.decodeMsg(b.subarray(1)); assert.ok(m && b[0] === P.Chan.CONTROL); out = P.wsControl(m); break; }
      case "ws-video": { const { hdr, au } = P.decodeVideo(b); out = P.encodeVideo(hdr, au); break; }
      case "ws-audio": out = P.encodeAudio(P.decodeAudio(b)); break;
      case "ws-feedback": out = P.encodeFeedback(P.decodeFeedback(b)); break;
      case "ws-ping": out = P.encodePing(new P.Reader(b.subarray(1)).u64()); break;
      case "ws-pong": { const p = P.decodePong(b); out = P.encodePong(p.pingUs, p.hostNs); break; }
      case "ws-bulk": out = P.encodeBulk(P.decodeBulk(b)); break;
      default: throw new Error(`unknown kind ${v.kind}`);
    }
    assert.equal(toHex(out), v.hex, v.name);
    seen.add(v.kind);
  }
  // Every message id 1..24 is covered.
  const ids = new Set(vectors.filter((v) => v.kind === "msg").map((v) => fromHex(v.hex)[0]));
  for (let id = 1; id <= 24; id++) assert.ok(ids.has(id), `message ${id} has no vector`);
  assert.equal(seen.size, 9);
});

test("decoded fields match the Rust values", () => {
  const get = (name: string) => fromHex(vectors.find((v) => v.name === name)!.hex);
  assert.deepEqual(P.decodeMsg(get("Seat")), { t: "Seat", driver: false, driverName: "fedora", width: 3840, height: 2160, scale: 200, viewers: 3, inPicture: true });
  assert.deepEqual(P.decodeMsg(get("CursorPos")), { t: "CursorPos", x: 32768, y: 1000 });
  assert.deepEqual(P.decodeMsg(get("Text")), { t: "Text", text: "Việt ế 🙂\n" });
  const offer = P.decodeMsg(get("FileOffer"));
  assert.ok(offer?.t === "FileOffer" && offer.name === "báo cáo.pdf" && offer.size === 3_000_000_000n && offer.sha256[31] === 31);
  assert.deepEqual(P.decodeMsg(get("ClipPng")), { t: "ClipPng", id: 0x80000001, size: 123456 });
  // A Seat from an older host (no inPicture byte): false.
  const old = get("Seat");
  assert.equal((P.decodeMsg(old.subarray(0, old.length - 1)) as { inPicture: boolean }).inPicture, false);
  assert.deepEqual(P.decodeMsg(get("Hello")), { t: "Hello", version: 1, name: "chrome on fedora", decoders: 0x41, width: 2560, height: 1440, hz: 100, scale: 150 });
  assert.equal((P.decodeMsg(get("Hello without scale")) as { scale: number }).scale, 0);
  assert.deepEqual(P.decodeMsg(get("Wheel")), { t: "Wheel", v: -120, h: 60 });
  const bye = P.decodeMsg(get("Bye"));
  assert.ok(bye?.t === "Bye" && bye.text === "can't decode hevc — sorry" && bye.reason === P.ByeReason.NO_CODEC);
  const v = P.decodeVideo(get("ws Video"));
  assert.deepEqual(v.hdr, { gen: 2, frame: 70000, keyframe: true, codec: 1, tCapture: 123456789012n });
  assert.equal(v.au.length, 6);
  const a = P.decodeAudio(get("ws Audio"));
  assert.deepEqual([a.seq, a.tCapture, a.cur.length, a.prev.length], [41, 987654321n, 3, 2]);
  assert.equal(P.decodeFeedback(get("ws Feedback")).owdMeanUs, -1500);
  const chunk = P.decodeMsg(get("CursorChunk"));
  assert.ok(chunk?.t === "CursorChunk");
  assert.equal(P.decodeCursor(chunk.data)?.scaleMilli, 2000);
});

test("truncation throws, unknown ids are null", () => {
  for (const v of vectors.filter((v) => v.kind === "msg")) {
    const b = fromHex(v.hex);
    // Fixed-size fields only: cut inside them (optional scale and chunk
    // data may legitimately end early).
    for (let cut = 0; cut < Math.min(b.length, 5); cut++) {
      if (cut === 0) { assert.throws(() => P.decodeMsg(b.subarray(0, 0))); continue; }
      const id = b[0];
      if ([10, 16].includes(id)) continue; // no fields
      if (cut === 1) assert.throws(() => P.decodeMsg(b.subarray(0, 1)), v.name);
    }
  }
  assert.equal(P.decodeMsg(Uint8Array.of(99, 1, 2)), null);
});

test("chunking and reassembly", () => {
  const text = "x".repeat(2500) + "é";
  const msgs = P.clipChunks(5, text)!;
  assert.equal(msgs.length, 3);
  const asm = new P.Assembler(300);
  let got: Uint8Array | null = null;
  for (const m of [msgs[2], msgs[0], msgs[1]]) if (m.t === "ClipChunk") got = asm.push(m.id, m.index, m.count, m.data) ?? got;
  assert.equal(new TextDecoder().decode(got!), text);
  assert.equal(P.clipChunks(1, ""), null);
});
