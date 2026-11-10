// Shapes and helpers the viewer shares with the rpc-host adapter: a video
// frame as the decoder takes it, a file chunk, WebCodecs codec strings,
// and the clipboard and text limits. It imports nothing, so the unit tests
// run it under Node as it is.

const Codec = { H264: 1, H265: 2 } as const;

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

export interface FileChunk {
  id: number;
  last: boolean;
  data: Uint8Array;
}

// ---- Codecs ----

/** The WebCodecs codec string, from the keyframe's parameter sets. */
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
  return "hev1.1.6.L153.B0";
}

export function codecLabel(codec: number): string {
  switch (codec) {
    case Codec.H264:
      return "H.264";
    case Codec.H265:
      return "H.265";
    default:
      return `codec ${codec}`;
  }
}

// ---- Text limits ----

/** The cap on a clipboard payload. */
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
