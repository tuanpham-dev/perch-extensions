// remote-pc's wire format for browser viewers: control messages
// (crates/rpc-proto/src/msg.rs) and the WebSocket channels
// (crates/rpc-proto/src/ws.rs). All integers little-endian; strings are
// u16 length + UTF-8. Checked against the vectors remote-pc generates
// (crates/rpc-proto/tests/vectors.rs → vectors.json) by rpc-proto.test.ts.

export const VERSION = 1;

/// Decoder bits in Hello.
// CURSOR_POS: following, this viewer draws the driver's pointer where
// CursorPos says (the pointer then stays out of the picture).
// BULK: takes files and PNG clipboard images (on the bulk channel).
export const Dec = { H264: 1, HEVC: 2, BULK: 0x08, CURSOR_POS: 0x10, CURSOR: 0x20, AUDIO: 0x40 } as const;
/// rpc_va codec ids.
export const Codec = { H264: 1, HEVC: 2 } as const;
/// Bye reasons.
export const ByeReason = { QUIT: 0, REPLACED: 1, NOT_PAIRED: 2, VERSION: 3, ERROR: 4, UNPAIRED: 5, NO_CODEC: 6, STOPPED: 7 } as const;
/// WebSocket channels (first byte of every binary message).
export const Chan = { CONTROL: 1, VIDEO: 2, AUDIO: 3, FEEDBACK: 4, PING: 5, PONG: 6, BULK: 7 } as const;
/// Chunk size of clipboard and cursor messages.
export const CLIP_CHUNK = 1000;
export const CLIP_MAX = 256 * 1024;

export class Writer {
  private buf = new Uint8Array(64);
  private len = 0;
  private dv = new DataView(this.buf.buffer);
  private room(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
    this.dv = new DataView(b.buffer);
  }
  u8(v: number): this { this.room(1); this.dv.setUint8(this.len, v); this.len += 1; return this; }
  bool(v: boolean): this { return this.u8(v ? 1 : 0); }
  u16(v: number): this { this.room(2); this.dv.setUint16(this.len, v, true); this.len += 2; return this; }
  i16(v: number): this { this.room(2); this.dv.setInt16(this.len, v, true); this.len += 2; return this; }
  u32(v: number): this { this.room(4); this.dv.setUint32(this.len, v >>> 0, true); this.len += 4; return this; }
  i32(v: number): this { this.room(4); this.dv.setInt32(this.len, v, true); this.len += 4; return this; }
  u64(v: bigint): this { this.room(8); this.dv.setBigUint64(this.len, v, true); this.len += 8; return this; }
  raw(v: Uint8Array): this { this.room(v.length); this.buf.set(v, this.len); this.len += v.length; return this; }
  str(v: string): this {
    const b = new TextEncoder().encode(v);
    const n = Math.min(b.length, 0xffff);
    return this.u16(n).raw(b.subarray(0, n));
  }
  done(): Uint8Array { return this.buf.slice(0, this.len); }
}

export class Reader {
  private pos = 0;
  private buf: Uint8Array;
  private dv: DataView;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number): void { if (this.pos + n > this.buf.length) throw new Error("message truncated"); }
  remaining(): number { return this.buf.length - this.pos; }
  done(): boolean { return this.pos >= this.buf.length; }
  u8(): number { this.need(1); return this.dv.getUint8(this.pos++); }
  bool(): boolean { return this.u8() !== 0; }
  u16(): number { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i32(): number { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  u64(): bigint { this.need(8); const v = this.dv.getBigUint64(this.pos, true); this.pos += 8; return v; }
  take(n: number): Uint8Array { this.need(n); const s = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return s; }
  rest(): Uint8Array { return this.take(this.remaining()); }
  str(): string { return new TextDecoder("utf-8", { fatal: false }).decode(this.take(this.u16())); }
}

export type Msg =
  /** `scale`: the viewer's UI scale ×100 (0: unknown, not sent). */
  | { t: "Hello"; version: number; name: string; decoders: number; width: number; height: number; hz: number; scale: number }
  | { t: "Welcome"; hostName: string; codec: number; width: number; height: number; hz: number }
  | { t: "ModeRequest"; width: number; height: number; hz: number; scale: number }
  | { t: "ModeApplied"; width: number; height: number; hz: number; gen: number }
  /** Linux evdev key code. */
  | { t: "Key"; code: number; down: boolean }
  | { t: "MouseRel"; dx: number; dy: number }
  /** Stream pixels. */
  | { t: "MouseAbs"; x: number; y: number }
  /** Linux BTN_* code. */
  | { t: "Button"; code: number; down: boolean }
  /** 1/120 notches, positive up / right. */
  | { t: "Wheel"; v: number; h: number }
  | { t: "KeyframeRequest" }
  | { t: "Bye"; reason: number; text: string }
  | { t: "ClipChunk"; id: number; index: number; count: number; data: Uint8Array }
  | { t: "CursorChunk"; id: number; index: number; count: number; data: Uint8Array }
  /** 0: no cap beyond the host's. */
  | { t: "RateCap"; kbps: number }
  | { t: "Seat"; driver: boolean; driverName: string; width: number; height: number; scale: number; viewers: number; inPicture: boolean }
  | { t: "TakeOver" }
  | { t: "Pause"; on: boolean }
  // The driver's pointer, as fractions of the picture (0–65535).
  | { t: "CursorPos"; x: number; y: number }
  // Characters to type whatever the desktop's layout (≤ 1000 bytes).
  | { t: "Text"; text: string }
  // A file to send (bytes follow as bulk chunks of `id` once accepted;
  // ids: the viewer's odd, the host's even), its answers and verdict.
  | { t: "FileOffer"; id: number; name: string; size: bigint; sha256: Uint8Array }
  | { t: "FileAccept"; id: number }
  | { t: "FileCancel"; id: number; reason: string }
  | { t: "FileDone"; id: number; ok: boolean }
  // The clipboard is a PNG of `size` bytes, coming as bulk chunks of `id`.
  | { t: "ClipPng"; id: number; size: number };

export function encodeMsg(m: Msg): Uint8Array {
  const w = new Writer();
  switch (m.t) {
    case "Hello": w.u8(1).u8(m.version).str(m.name).u8(m.decoders).u16(m.width).u16(m.height).u16(m.hz); if (m.scale) w.u16(m.scale); break;
    case "Welcome": w.u8(2).str(m.hostName).u8(m.codec).u16(m.width).u16(m.height).u16(m.hz); break;
    case "ModeRequest": w.u8(3).u16(m.width).u16(m.height).u16(m.hz); if (m.scale) w.u16(m.scale); break;
    case "ModeApplied": w.u8(4).u16(m.width).u16(m.height).u16(m.hz).u16(m.gen); break;
    case "Key": w.u8(5).u16(m.code).bool(m.down); break;
    case "MouseRel": w.u8(6).i16(m.dx).i16(m.dy); break;
    case "MouseAbs": w.u8(7).u16(m.x).u16(m.y); break;
    case "Button": w.u8(8).u16(m.code).bool(m.down); break;
    case "Wheel": w.u8(9).i16(m.v).i16(m.h); break;
    case "KeyframeRequest": w.u8(10); break;
    case "Bye": w.u8(11).u8(m.reason).str(m.text); break;
    case "ClipChunk": w.u8(12).u32(m.id).u16(m.index).u16(m.count).raw(m.data); break;
    case "CursorChunk": w.u8(13).u32(m.id).u16(m.index).u16(m.count).raw(m.data); break;
    case "RateCap": w.u8(14).u32(m.kbps); break;
    case "Seat": w.u8(15).bool(m.driver).str(m.driverName).u16(m.width).u16(m.height).u16(m.scale).u16(m.viewers).bool(m.inPicture); break;
    case "TakeOver": w.u8(16); break;
    case "Pause": w.u8(17).bool(m.on); break;
    case "CursorPos": w.u8(18).u16(m.x).u16(m.y); break;
    case "Text": w.u8(19).str(m.text); break;
    case "FileOffer": w.u8(20).u32(m.id).str(m.name).u64(m.size).raw(m.sha256); break;
    case "FileAccept": w.u8(21).u32(m.id); break;
    case "FileCancel": w.u8(22).u32(m.id).str(m.reason); break;
    case "FileDone": w.u8(23).u32(m.id).bool(m.ok); break;
    case "ClipPng": w.u8(24).u32(m.id).u32(m.size); break;
  }
  return w.done();
}

/** Throws on a truncated message; null for an id this side doesn't know
 *  (a newer host's). Trailing bytes are a newer peer's fields: ignored. */
export function decodeMsg(b: Uint8Array): Msg | null {
  const r = new Reader(b);
  const id = r.u8();
  switch (id) {
    case 1: return { t: "Hello", version: r.u8(), name: r.str(), decoders: r.u8(), width: r.u16(), height: r.u16(), hz: r.u16(), scale: r.done() ? 0 : r.u16() };
    case 2: return { t: "Welcome", hostName: r.str(), codec: r.u8(), width: r.u16(), height: r.u16(), hz: r.u16() };
    case 3: return { t: "ModeRequest", width: r.u16(), height: r.u16(), hz: r.u16(), scale: r.done() ? 0 : r.u16() };
    case 4: return { t: "ModeApplied", width: r.u16(), height: r.u16(), hz: r.u16(), gen: r.u16() };
    case 5: return { t: "Key", code: r.u16(), down: r.bool() };
    case 6: return { t: "MouseRel", dx: r.i16(), dy: r.i16() };
    case 7: return { t: "MouseAbs", x: r.u16(), y: r.u16() };
    case 8: return { t: "Button", code: r.u16(), down: r.bool() };
    case 9: return { t: "Wheel", v: r.i16(), h: r.i16() };
    case 10: return { t: "KeyframeRequest" };
    case 11: return { t: "Bye", reason: r.u8(), text: r.str() };
    case 12: return { t: "ClipChunk", id: r.u32(), index: r.u16(), count: r.u16(), data: r.rest().slice() };
    case 13: return { t: "CursorChunk", id: r.u32(), index: r.u16(), count: r.u16(), data: r.rest().slice() };
    case 14: return { t: "RateCap", kbps: r.u32() };
    case 15: return { t: "Seat", driver: r.bool(), driverName: r.str(), width: r.u16(), height: r.u16(), scale: r.u16(), viewers: r.u16(), inPicture: r.done() ? false : r.bool() };
    case 16: return { t: "TakeOver" };
    case 17: return { t: "Pause", on: r.bool() };
    case 18: return { t: "CursorPos", x: r.u16(), y: r.u16() };
    case 19: return { t: "Text", text: r.str() };
    case 20: return { t: "FileOffer", id: r.u32(), name: r.str(), size: r.u64(), sha256: r.take(32).slice() };
    case 21: return { t: "FileAccept", id: r.u32() };
    case 22: return { t: "FileCancel", id: r.u32(), reason: r.str() };
    case 23: return { t: "FileDone", id: r.u32(), ok: r.bool() };
    case 24: return { t: "ClipPng", id: r.u32(), size: r.u32() };
    default: return null;
  }
}

/** The host's cursor shape (reassembled from CursorChunk). */
export interface Cursor { width: number; height: number; hotX: number; hotY: number; scaleMilli: number; rgba: Uint8Array }

export function decodeCursor(b: Uint8Array): Cursor | null {
  if (b.length < 10) return null;
  const r = new Reader(b);
  const c = { width: r.u16(), height: r.u16(), hotX: r.u16(), hotY: r.u16(), scaleMilli: r.u16(), rgba: r.rest().slice() };
  if (!c.width || !c.height || c.width > 128 || c.height > 128 || c.rgba.length !== c.width * c.height * 4) return null;
  return c;
}

export function encodeCursor(c: Cursor): Uint8Array {
  return new Writer().u16(c.width).u16(c.height).u16(c.hotX).u16(c.hotY).u16(c.scaleMilli).raw(c.rgba).done();
}

/** Chunked bytes (clipboard, cursor) put back together; a new id starts over. */
export class Assembler {
  private id: number | null = null;
  private parts: (Uint8Array | null)[] = [];
  private maxChunks: number;
  constructor(maxChunks: number) { this.maxChunks = maxChunks; }
  push(id: number, index: number, count: number, data: Uint8Array): Uint8Array | null {
    if (count === 0 || index >= count || count > this.maxChunks) return null;
    if (this.id !== id || this.parts.length !== count) {
      this.id = id;
      this.parts = new Array(count).fill(null);
    }
    this.parts[index] = data;
    if (this.parts.some((p) => p === null)) return null;
    this.id = null;
    const n = this.parts.reduce((a, p) => a + p!.length, 0);
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of this.parts) { out.set(p!, at); at += p!.length; }
    this.parts = [];
    return out;
  }
}

/** Clipboard text as ClipChunk messages (null: empty or over CLIP_MAX). */
export function clipChunks(id: number, text: string): Msg[] | null {
  const b = new TextEncoder().encode(text);
  if (!b.length || b.length > CLIP_MAX) return null;
  const count = Math.ceil(b.length / CLIP_CHUNK);
  const out: Msg[] = [];
  for (let i = 0; i < count; i++) out.push({ t: "ClipChunk", id, index: i, count, data: b.subarray(i * CLIP_CHUNK, (i + 1) * CLIP_CHUNK) });
  return out;
}

// ---- WebSocket channels ----

/** A control message as a WebSocket message. */
export function wsControl(m: Msg): Uint8Array {
  const body = encodeMsg(m);
  const out = new Uint8Array(body.length + 1);
  out[0] = Chan.CONTROL;
  out.set(body, 1);
  return out;
}

export interface VideoHdr { gen: number; frame: number; keyframe: boolean; codec: number; tCapture: bigint }
export const VIDEO_HDR = 17;

/** A video message: its header and access unit (Annex B; a view, not a copy). */
export function decodeVideo(b: Uint8Array): { hdr: VideoHdr; au: Uint8Array } {
  const r = new Reader(b);
  if (r.u8() !== Chan.VIDEO) throw new Error("not a video message");
  const hdr = { gen: r.u16(), frame: r.u32(), keyframe: (r.u8() & 1) !== 0, codec: r.u8(), tCapture: r.u64() };
  return { hdr, au: r.rest() };
}

export function encodeVideo(h: VideoHdr, au: Uint8Array): Uint8Array {
  return new Writer().u8(Chan.VIDEO).u16(h.gen).u32(h.frame).u8(h.keyframe ? 1 : 0).u8(h.codec).u64(h.tCapture).raw(au).done();
}

/** rpc-audio packet: seq, capture time (host ns), this frame's Opus, the
 *  previous frame's (redundancy, may be empty). Empty `cur`: the host went quiet. */
export interface AudioPacket { seq: number; tCapture: bigint; cur: Uint8Array; prev: Uint8Array }

export function decodeAudio(b: Uint8Array): AudioPacket {
  const r = new Reader(b);
  if (r.u8() !== Chan.AUDIO) throw new Error("not an audio message");
  const seq = r.u32(), tCapture = r.u64();
  const cur = r.take(r.u16());
  return { seq, tCapture, cur, prev: r.rest() };
}

export function encodeAudio(p: AudioPacket): Uint8Array {
  return new Writer().u8(Chan.AUDIO).u32(p.seq).u64(p.tCapture).u16(p.cur.length).raw(p.cur).raw(p.prev).done();
}

/** What the browser measures, about every 100 ms. Delays in µs on the
 *  browser clock shifted by the host offset from pings (trends matter). */
export interface Feedback { decoded: number; dropped: number; bytes: number; windowUs: number; owdMeanUs: number; owdMaxUs: number; decodeQueue: number }

export function encodeFeedback(f: Feedback): Uint8Array {
  return new Writer().u8(Chan.FEEDBACK).u32(f.decoded).u16(f.dropped).u32(f.bytes).u32(f.windowUs).i32(f.owdMeanUs).i32(f.owdMaxUs).u16(f.decodeQueue).done();
}

export function decodeFeedback(b: Uint8Array): Feedback {
  const r = new Reader(b);
  if (r.u8() !== Chan.FEEDBACK) throw new Error("not feedback");
  return { decoded: r.u32(), dropped: r.u16(), bytes: r.u32(), windowUs: r.u32(), owdMeanUs: r.i32(), owdMaxUs: r.i32(), decodeQueue: r.u16() };
}

/** A ping at browser time `us` (µs). */
export function encodePing(us: bigint): Uint8Array {
  return new Writer().u8(Chan.PING).u64(us).done();
}

/** The pong: our ping time (µs) and the host's clock (ns). */
export function decodePong(b: Uint8Array): { pingUs: bigint; hostNs: bigint } {
  const r = new Reader(b);
  if (r.u8() !== Chan.PONG) throw new Error("not a pong");
  return { pingUs: r.u64(), hostNs: r.u64() };
}

export function encodePong(pingUs: bigint, hostNs: bigint): Uint8Array {
  return new Writer().u8(Chan.PONG).u64(pingUs).u64(hostNs).done();
}

export interface Bulk { id: number; index: number; count: number; data: Uint8Array }

export function encodeBulk(k: Bulk): Uint8Array {
  return new Writer().u8(Chan.BULK).u32(k.id).u32(k.index).u32(k.count).raw(k.data).done();
}

export function decodeBulk(b: Uint8Array): Bulk {
  const r = new Reader(b);
  if (r.u8() !== Chan.BULK) throw new Error("not bulk");
  const k = { id: r.u32(), index: r.u32(), count: r.u32(), data: r.rest().slice() };
  if (k.index >= k.count) throw new Error("bulk index out of range");
  return k;
}
