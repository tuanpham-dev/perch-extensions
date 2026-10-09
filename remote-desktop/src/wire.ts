// The WebSocket framing between the viewer and qr-host's gateway
// (quick-remote docs/protocol.md, "WebSocket transport"): every message is
// binary, its first byte names the channel, and the payloads are the
// protocol's own encodings (src/qr/proto.ts). This module holds what is
// not in the vendored protocol: the channel byte, the video frame layout,
// the gateway's seat messages, file chunks and the codec strings. It
// imports nothing, so the unit tests run it under Node as it is; the
// little-endian reading and writing here mirror proto.ts's Reader/Writer.

const Codec = { H264: 1, H265: 2, AV1: 3 } as const;

class Reader {
  private pos = 0;
  private readonly buf: Uint8Array;
  private readonly dv: DataView;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error("message truncated");
  }
  remaining(): number {
    return this.buf.length - this.pos;
  }
  finish(): void {
    if (this.remaining() !== 0) throw new Error(`${this.remaining()} trailing bytes`);
  }
  u8(): number {
    this.need(1);
    return this.dv.getUint8(this.pos++);
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u16(): number {
    this.need(2);
    const v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.dv.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  rest(): Uint8Array {
    const s = this.buf.subarray(this.pos);
    this.pos = this.buf.length;
    return s;
  }
  str(): string {
    const n = this.u32();
    this.need(n);
    const s = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return new TextDecoder("utf-8", { fatal: true }).decode(s);
  }
}

class Writer {
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
  u8(v: number): this {
    this.room(1);
    this.dv.setUint8(this.len, v);
    this.len += 1;
    return this;
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  u16(v: number): this {
    this.room(2);
    this.dv.setUint16(this.len, v, true);
    this.len += 2;
    return this;
  }
  u32(v: number): this {
    this.room(4);
    this.dv.setUint32(this.len, v, true);
    this.len += 4;
    return this;
  }
  raw(v: Uint8Array): this {
    this.room(v.length);
    this.buf.set(v, this.len);
    this.len += v.length;
    return this;
  }
  str(v: string): this {
    const b = new TextEncoder().encode(v);
    return this.u32(b.length).raw(b);
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export const Channel = { CONTROL: 0, INPUT: 1, VIDEO: 2, DATAGRAM: 3, FILE: 4, SEAT: 5 } as const;

/** A whole message: the channel byte in front of the payload. */
export function wrap(channel: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + payload.length);
  out[0] = channel;
  out.set(payload, 1);
  return out;
}

// ---- Video (channel 2): stream u8, FrameMeta (42 bytes), access unit ----

export const FRAME_META_LEN = 42;
export const FrameFlags = { KEYFRAME: 1, CHROMA444: 2, REFRESH: 4 } as const;

export interface FrameMeta {
  codec: number;
  flags: number;
  width: number;
  height: number;
  /** Access-unit length as the host wrote it. */
  len: number;
  captureUs: bigint;
  encodeStartUs: bigint;
  encodeEndUs: bigint;
  /** Host monotonic clock: only differences between frames mean anything here. */
  sendUs: bigint;
}

export interface VideoFrame {
  stream: number;
  meta: FrameMeta;
  keyframe: boolean;
  au: Uint8Array;
}

/** Parses a channel-2 payload (after the channel byte); null when malformed. */
export function parseVideo(payload: Uint8Array): VideoFrame | null {
  if (payload.length < 1 + FRAME_META_LEN) return null;
  const r = new Reader(payload);
  const stream = r.u8();
  const meta: FrameMeta = {
    codec: r.u8(),
    flags: r.u8(),
    width: r.u16(),
    height: r.u16(),
    len: r.u32(),
    captureUs: r.u64(),
    encodeStartUs: r.u64(),
    encodeEndUs: r.u64(),
    sendUs: r.u64(),
  };
  const au = r.rest();
  if (au.length !== meta.len) return null;
  return { stream, meta, keyframe: (meta.flags & FrameFlags.KEYFRAME) !== 0, au };
}

// ---- Seat (channel 5): sub u8, then Seat (1, host → viewer) or Claim (2) ----

export interface Seat {
  driver: boolean;
  scalePct: number;
  driverRatioPct: number;
  viewers: number;
  cursorInPicture: boolean;
}

export type SeatMessage = ({ t: "Seat" } & Seat) | { t: "Claim"; viewerId: string };

export function encodeSeatMessage(m: SeatMessage): Uint8Array {
  const w = new Writer();
  if (m.t === "Seat") {
    w.u8(1).bool(m.driver).u16(m.scalePct).u16(m.driverRatioPct).u16(m.viewers).bool(m.cursorInPicture);
  } else {
    w.u8(2).str(m.viewerId);
  }
  return w.done();
}

export function decodeSeatMessage(payload: Uint8Array): SeatMessage {
  const r = new Reader(payload);
  const sub = r.u8();
  let m: SeatMessage;
  if (sub === 1) {
    m = { t: "Seat", driver: r.bool(), scalePct: r.u16(), driverRatioPct: r.u16(), viewers: r.u16(), cursorInPicture: r.bool() };
  } else if (sub === 2) {
    m = { t: "Claim", viewerId: r.str() };
  } else {
    throw new Error(`unknown seat message ${sub}`);
  }
  r.finish();
  return m;
}

export const claimMessage = (viewerId: string) => wrap(Channel.SEAT, encodeSeatMessage({ t: "Claim", viewerId }));

// ---- File (channel 4): id u32, last bool, bytes ----

export interface FileChunk {
  id: number;
  last: boolean;
  data: Uint8Array;
}

export function encodeFileChunk(c: FileChunk): Uint8Array {
  return new Writer().u32(c.id).bool(c.last).raw(c.data).done();
}

export function decodeFileChunk(payload: Uint8Array): FileChunk {
  const r = new Reader(payload);
  return { id: r.u32(), last: r.bool(), data: r.rest() };
}

export const fileMessage = (c: FileChunk) => wrap(Channel.FILE, encodeFileChunk(c));

// ---- Codecs ----

/** The WebCodecs codec string, from the keyframe's parameter sets (ported
 * from quick-remote web/src/main.ts). */
export function codecString(codec: number, au: Uint8Array): string {
  if (codec === Codec.H264) {
    for (let i = 0; i + 7 < au.length; i++) {
      if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 7) {
        const h = (x: number) => x.toString(16).padStart(2, "0");
        return `avc1.${h(au[i + 4])}${h(au[i + 5])}${h(au[i + 6])}`;
      }
    }
    return "avc1.640033";
  }
  if (codec === Codec.H265) return "hev1.1.6.L153.B0";
  return "av01.0.08M.08";
}

export function codecLabel(codec: number): string {
  switch (codec) {
    case Codec.H264:
      return "H.264";
    case Codec.H265:
      return "H.265";
    case Codec.AV1:
      return "AV1";
    default:
      return `codec ${codec}`;
  }
}

// ---- Text limits ----

/** The protocol's cap on a clipboard payload. */
export const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024;

// Clip text to the cap without splitting a UTF-8 sequence.
export function clipClipboardText(text: string): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_CLIPBOARD_BYTES) return { text, truncated: false };
  let cut = MAX_CLIPBOARD_BYTES;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return { text: new TextDecoder().decode(bytes.subarray(0, cut)), truncated: true };
}

/** Most characters one `Text` input event carries. */
export const MAX_TEXT_CHARS = 4096;

/** Split text into events of at most `max` characters (code points), never
 * between the halves of a surrogate pair. */
export function chunkText(text: string, max = MAX_TEXT_CHARS): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join(""));
  return out;
}
