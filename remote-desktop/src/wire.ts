// The WebSocket wire format shared with quicdesk-server (crates/server/src/
// wire.rs): JSON text messages tagged by `t`, and binary video frames with a
// 28-byte little-endian header ahead of the H.264 Annex B payload.

export const FRAME_HEADER_LEN = 28;
/** Header plus tile count (u16) and a reserved u16. */
export const FRAME_PREFIX_LEN = 32;
/** Per tile: u16 x, y, width, height, u32 flags, u32 byte length. */
export const TILE_DESC_LEN = 16;
const FLAG_KEYFRAME = 1;

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameTile {
  rect: TileRect;
  keyframe: boolean;
  data: Uint8Array;
}

/** A frame as the server sends it: the whole picture's header plus one
 * tile per encoder (one covering the frame unless the display is larger
 * than one encoder takes; tiles the encoder skipped are absent). */
export interface ParsedFrame {
  header: FrameHeader;
  tiles: FrameTile[];
}

export function parseFrame(buf: ArrayBuffer): ParsedFrame | null {
  const header = parseFrameHeader(buf);
  if (!header || buf.byteLength < FRAME_PREFIX_LEN) return null;
  const dv = new DataView(buf);
  const count = dv.getUint16(28, true);
  let desc = FRAME_PREFIX_LEN;
  let at = desc + count * TILE_DESC_LEN;
  if (at > buf.byteLength) return null;
  const tiles: FrameTile[] = [];
  for (let i = 0; i < count; i++, desc += TILE_DESC_LEN) {
    const len = dv.getUint32(desc + 12, true);
    if (at + len > buf.byteLength) return null;
    tiles.push({
      rect: { x: dv.getUint16(desc, true), y: dv.getUint16(desc + 2, true), w: dv.getUint16(desc + 4, true), h: dv.getUint16(desc + 6, true) },
      keyframe: (dv.getUint32(desc + 8, true) & FLAG_KEYFRAME) === FLAG_KEYFRAME,
      data: new Uint8Array(buf, at, len),
    });
    at += len;
  }
  return { header, tiles };
}

export interface FrameHeader {
  frameId: number;
  keyframe: boolean;
  width: number;
  height: number;
  timestampUs: number;
}

export function parseFrameHeader(buf: ArrayBuffer): FrameHeader | null {
  if (buf.byteLength < FRAME_HEADER_LEN) return null;
  const dv = new DataView(buf);
  return {
    frameId: Number(dv.getBigUint64(0, true)),
    keyframe: (dv.getUint32(8, true) & FLAG_KEYFRAME) === FLAG_KEYFRAME,
    width: dv.getUint32(12, true),
    height: dv.getUint32(16, true),
    timestampUs: Number(dv.getBigUint64(20, true)),
  };
}

// Annex B start codes (00 00 01, usually preceded by another 00) delimit
// NAL units. Each returned slice keeps its start code.
export function splitNalUnits(payload: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 2 < payload.length; i++) {
    if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 1) {
      // Prefer the 4-byte form when a zero precedes the 3-byte code.
      const start = i > 0 && payload[i - 1] === 0 ? i - 1 : i;
      if (starts.length === 0 || start > starts[starts.length - 1] + 3) starts.push(start);
      i += 2;
    }
  }
  if (starts.length === 0) return payload.length > 0 ? [payload] : [];
  const out: Uint8Array[] = [];
  for (let n = 0; n < starts.length; n++) {
    const end = n + 1 < starts.length ? starts[n + 1] : payload.length;
    out.push(payload.subarray(starts[n], end));
  }
  return out;
}

/** The stream formats, best first, with the codec string each is probed
 * with (level 5.1, as the server encodes: hardware decoders may refuse a 4K
 * stream configured as a lower level). H.264 chunks carry Annex B start
 * codes and AV1 chunks low-overhead OBUs, so no description is needed. The
 * server picks the best one both sides have: a server with only openh264
 * sends constrained baseline whatever the browser can do. */
export const FORMATS = [
  { name: "av1", codec: "av01.0.13M.08", label: "AV1" },
  { name: "h264", codec: "avc1.640033", label: "H.264" },
  { name: "h264-baseline", codec: "avc1.42E033", label: "H.264 baseline" },
] as const;
export type FormatName = (typeof FORMATS)[number]["name"];
/** Constrained baseline: what a server without format negotiation sends. */
export const BASELINE_CODEC_STRING = "avc1.42E033";

export function formatLabel(name: string): string {
  return FORMATS.find((f) => f.name === name)?.label ?? name;
}

export type ClientMsg =
  | { t: "hello"; version: number; name: string; width: number; height: number; pixelRatio: number; codecs: string[] }
  | { t: "claim" }
  | { t: "scale"; ratio: number }
  | { t: "key"; code: number; down: boolean }
  | { t: "move"; x: number; y: number }
  | { t: "button"; button: number; down: boolean }
  | { t: "wheel"; dx: number; dy: number }
  | { t: "resize"; width: number; height: number }
  | { t: "clipboard"; text: string }
  | { t: "pause" }
  | { t: "resume" }
  | { t: "keyframe" }
  | { t: "releaseKeys" }
  | { t: "text"; text: string }
  | { t: "stats"; fps: number; decodeMs: number; gaps: number; kbps: number }
  | { t: "ping"; seq: number; sent: number };

export interface ServerHello {
  t: "hello";
  version: number;
  width: number;
  height: number;
  maxWidth: number;
  maxHeight: number;
  fps: number;
  /** The stream format this viewer gets: av1, h264 or h264-baseline. */
  codec: string;
  /** The stream's codec string, for VideoDecoder.configure. Missing from
   * servers older than format negotiation, which send baseline. */
  codecString?: string;
  resize: boolean;
  clipboard: boolean;
  viewers: number;
  /** Whether this viewer drives the display's size and scale. */
  driver: boolean;
  /** The desktop's UI scale (the driver's pixel ratio). */
  scale: number;
  /** The driver's pixel ratio: followers lay the picture out by it. */
  driverRatio: number;
}

export type ServerMsg =
  | ServerHello
  | { t: "driver"; you: boolean; scale: number; driverRatio: number }
  | { t: "resized"; width: number; height: number }
  | { t: "clipboard"; text: string }
  | { t: "cursor"; width: number; height: number; xhot: number; yhot: number; png: string }
  | { t: "pong"; seq: number; sent: number }
  | { t: "viewers"; n: number }
  | { t: "error"; reason: string };

export const WS_PROTOCOL_VERSION = 1;
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;

// Clip text to the server's cap without splitting a UTF-8 sequence.
export function clipClipboardText(text: string): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_CLIPBOARD_BYTES) return { text, truncated: false };
  let cut = MAX_CLIPBOARD_BYTES;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return { text: new TextDecoder().decode(bytes.subarray(0, cut)), truncated: true };
}

/** Most characters one `text` message may carry (the server's cap). */
export const MAX_TEXT_CHARS = 4096;

/** Split text into `text` messages of at most `max` characters (code
 * points), never between the halves of a surrogate pair. */
export function chunkText(text: string, max = MAX_TEXT_CHARS): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join(""));
  return out;
}
