// Decoding with WebCodecs: one stream, configured from each keyframe's
// parameter sets (the codec string can change when the host restarts the
// stream with another encoder). Hardware where the browser has it. There
// is no software fallback: a browser without WebCodecs gets a banner.
import { Codec, type CodecCap } from "./qr/proto";
import { codecString, type VideoFrame as WireFrame } from "./wire";

/** Frames a decoder may hold before the viewer skips to the next keyframe. */
const MAX_QUEUED_FRAMES = 4;

export interface Decoder {
  decode(frame: WireFrame): void;
  /** Forget the stream's state so the next keyframe starts fresh. */
  reset(): void;
  close(): void;
  /** The codec string in use, once configured. */
  readonly codec: string;
}

export interface DecoderOptions {
  onPicture(frame: VideoFrame, decodeMs: number): void;
  /** The decoder lost its way: the host should send a keyframe. */
  onNeedKeyframe(): void;
}

export function hasWebCodecs(): boolean {
  return typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
}

/** What this browser decodes, best first, as the hello carries it. Ported
 * from quick-remote web/src/main.ts (`decoderCaps`). */
export async function probeDecoders(): Promise<CodecCap[]> {
  const out: CodecCap[] = [];
  if (!hasWebCodecs()) return out;
  const tries: [number, string][] = [
    [Codec.AV1, "av01.0.08M.08"],
    [Codec.H265, "hev1.1.6.L153.B0"],
    [Codec.H264, "avc1.640033"],
  ];
  for (const [codec, s] of tries) {
    for (const hw of [true, false]) {
      try {
        const accel = hw ? "prefer-hardware" : "prefer-software";
        const r = await VideoDecoder.isConfigSupported({ codec: s, hardwareAcceleration: accel });
        if (!r.supported) continue;
        // The largest picture this decoder takes (Chrome checks the coded
        // size against what the hardware reports).
        let [maxWidth, maxHeight] = [1920, 1080];
        for (const [w, h] of [
          [8192, 4352],
          [7680, 4320],
          [4096, 4096],
          [4096, 2304],
        ]) {
          const big = await VideoDecoder.isConfigSupported({ codec: s, codedWidth: w, codedHeight: h, hardwareAcceleration: accel }).catch(
            () => ({ supported: false }),
          );
          if (big.supported) {
            [maxWidth, maxHeight] = [w, h];
            break;
          }
        }
        out.push({ codec, hw, maxWidth, maxHeight, chroma444: false });
        break;
      } catch {
        // unsupported here
      }
    }
  }
  return out;
}

export function createDecoder(opts: DecoderOptions): Decoder {
  return new WebCodecsDecoder(opts);
}

class WebCodecsDecoder implements Decoder {
  private decoder: VideoDecoder | null = null;
  private seenKeyframe = false;
  private submitted = new Map<number, number>();
  private closed = false;
  private asked = 0;
  codec = "";

  constructor(private readonly opts: DecoderOptions) {}


  private build(codec: string): VideoDecoder {
    const decoder = new VideoDecoder({
      output: (frame) => {
        const started = this.submitted.get(frame.timestamp);
        this.submitted.delete(frame.timestamp);
        const decodeMs = started === undefined ? 0 : performance.now() - started;
        if (this.closed) {
          frame.close();
          return;
        }
        this.opts.onPicture(frame, decodeMs);
      },
      error: () => {
        // A corrupt or out-of-order chunk: start over from the next keyframe.
        this.reset();
        this.needKeyframe();
      },
    });
    decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "no-preference" });
    return decoder;
  }

  // At most one request per 250 ms: the host ignores faster ones anyway.
  private needKeyframe(): void {
    const now = performance.now();
    if (now - this.asked < 250) return;
    this.asked = now;
    this.opts.onNeedKeyframe();
  }

  decode(frame: WireFrame): void {
    if (this.closed) return;
    if (frame.keyframe) {
      const s = codecString(frame.meta.codec, frame.au);
      if (!this.decoder || s !== this.codec || this.decoder.state !== "configured") {
        this.reset();
        this.codec = s;
        this.decoder = this.build(s);
      }
      this.seenKeyframe = true;
    } else if (!this.seenKeyframe || !this.decoder || this.decoder.state !== "configured") {
      this.needKeyframe();
      return;
    }
    // A decoder that cannot keep up would queue frames without bound and
    // show each one later than the last: skip to the next keyframe
    // instead, so what is shown stays current (the host also lowers the
    // frame rate from the decode times the viewer reports).
    if (!frame.keyframe && this.decoder!.decodeQueueSize > MAX_QUEUED_FRAMES) {
      this.seenKeyframe = false;
      this.submitted.clear();
      this.needKeyframe();
      return;
    }
    const timestamp = Number(frame.meta.captureUs & 0xffffffffffffn);
    this.submitted.set(timestamp, performance.now());
    try {
      this.decoder!.decode(new EncodedVideoChunk({ type: frame.keyframe ? "key" : "delta", timestamp, data: frame.au }));
    } catch {
      this.reset();
      this.needKeyframe();
    }
  }

  reset(): void {
    this.seenKeyframe = false;
    this.submitted.clear();
    try {
      this.decoder?.close();
    } catch {
      // already closed
    }
    this.decoder = null;
    this.codec = "";
  }

  close(): void {
    this.closed = true;
    this.reset();
  }
}
