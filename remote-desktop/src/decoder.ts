// H.264 decoding, one stream per tile: WebCodecs (hardware where the
// browser has it) or the bundled tinyh264 worker (software, constrained
// baseline) when WebCodecs is missing or the user forces it. A frame no
// larger than one encoder takes has a single tile covering it; a larger
// display arrives as a grid, and every tile keeps its own decoder.
import { H264_CODEC_STRING, splitNalUnits, type FrameTile, type ParsedFrame, type TileRect } from "./wire";

export type DecodedPicture = (
  | { kind: "video"; frame: VideoFrame }
  | { kind: "i420"; data: Uint8Array; codedWidth: number; codedHeight: number; width: number; height: number }
) & { rect: TileRect };

export interface Decoder {
  readonly kind: "webcodecs" | "wasm";
  decode(frame: ParsedFrame): void;
  /** Forget every tile's state so the next keyframes start fresh. */
  reset(): void;
  close(): void;
}

export interface DecoderOptions {
  forceWasm: boolean;
  workerUrl: string;
  onPicture(picture: DecodedPicture, decodeMs: number): void;
  onNeedKeyframe(): void;
}

interface TileDecoder {
  decode(tile: FrameTile, timestampUs: number): void;
  close(): void;
}

export async function createDecoder(opts: DecoderOptions): Promise<Decoder> {
  if (!opts.forceWasm && (await webCodecsSupported())) {
    return new TiledDecoder("webcodecs", (rect) => new WebCodecsTile(rect, opts), () => {});
  }
  const router = await WasmRouter.start(opts);
  return new TiledDecoder("wasm", (rect) => router.tile(rect), () => router.close());
}

async function webCodecsSupported(): Promise<boolean> {
  if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") return false;
  try {
    const support = await VideoDecoder.isConfigSupported({ codec: H264_CODEC_STRING });
    return support.supported === true;
  } catch {
    return false;
  }
}

const rectKey = (r: TileRect) => `${r.x},${r.y},${r.w},${r.h}`;

class TiledDecoder implements Decoder {
  private tiles = new Map<string, TileDecoder>();
  private frameSize = "";

  constructor(
    readonly kind: "webcodecs" | "wasm",
    private readonly make: (rect: TileRect) => TileDecoder,
    private readonly onClose: () => void,
  ) {}

  decode(frame: ParsedFrame): void {
    // A new frame size means a new tile grid: every stream restarts.
    const size = `${frame.header.width}x${frame.header.height}`;
    if (size !== this.frameSize) {
      this.reset();
      this.frameSize = size;
    }
    for (const tile of frame.tiles) {
      const key = rectKey(tile.rect);
      let dec = this.tiles.get(key);
      if (!dec) {
        dec = this.make(tile.rect);
        this.tiles.set(key, dec);
      }
      dec.decode(tile, frame.header.timestampUs);
    }
  }

  reset(): void {
    for (const t of this.tiles.values()) t.close();
    this.tiles.clear();
  }

  close(): void {
    this.reset();
    this.onClose();
  }
}

class WebCodecsTile implements TileDecoder {
  private decoder: VideoDecoder;
  private seenKeyframe = false;
  private submitted = new Map<number, number>();
  private closed = false;

  constructor(
    private readonly rect: TileRect,
    private readonly opts: DecoderOptions,
  ) {
    this.decoder = this.build();
  }

  private build(): VideoDecoder {
    const decoder = new VideoDecoder({
      output: (frame) => {
        const started = this.submitted.get(frame.timestamp);
        this.submitted.delete(frame.timestamp);
        const decodeMs = started === undefined ? 0 : performance.now() - started;
        if (this.closed) {
          frame.close();
          return;
        }
        this.opts.onPicture({ kind: "video", frame, rect: this.rect }, decodeMs);
      },
      error: () => {
        // A corrupt or out-of-order chunk: start over from the next keyframe.
        this.restart();
        this.opts.onNeedKeyframe();
      },
    });
    decoder.configure({
      codec: H264_CODEC_STRING,
      optimizeForLatency: true,
      // The server converts BGRX to full-swing BT.601 without writing VUI
      // into the stream, so tell the decoder rather than let it assume
      // limited range and crush the blacks.
      colorSpace: { primaries: "bt709", transfer: "iec61966-2-1", matrix: "smpte170m", fullRange: true },
    } as VideoDecoderConfig);
    return decoder;
  }

  private restart(): void {
    this.seenKeyframe = false;
    this.submitted.clear();
    try {
      this.decoder.close();
    } catch {
      // already closed
    }
    if (!this.closed) this.decoder = this.build();
  }

  decode(tile: FrameTile, timestampUs: number): void {
    if (this.closed) return;
    if (!this.seenKeyframe) {
      if (!tile.keyframe) return;
      this.seenKeyframe = true;
    }
    if (this.decoder.state !== "configured") {
      this.restart();
      if (!tile.keyframe) {
        this.opts.onNeedKeyframe();
        return;
      }
      this.seenKeyframe = true;
    }
    this.submitted.set(timestampUs, performance.now());
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: tile.keyframe ? "key" : "delta", timestamp: timestampUs, data: tile.data }));
    } catch {
      this.restart();
      this.opts.onNeedKeyframe();
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.decoder.close();
    } catch {
      // already closed
    }
  }
}

interface WorkerPicture {
  type: "pictureReady";
  renderStateId: number;
  width: number;
  height: number;
  data: ArrayBuffer;
}

/** One tinyh264 worker for every tile; each tile is a render state in it. */
class WasmRouter {
  private tiles = new Map<number, WasmTile>();
  private nextId = 1;

  private constructor(
    private readonly worker: Worker,
    private readonly opts: DecoderOptions,
  ) {
    worker.onmessage = (e: MessageEvent<WorkerPicture | { type: string }>) => {
      if (e.data.type !== "pictureReady") return;
      const pic = e.data as WorkerPicture;
      this.tiles.get(pic.renderStateId)?.picture(pic);
    };
  }

  static async start(opts: DecoderOptions): Promise<WasmRouter> {
    // The bundle is fetched here and started from a Blob URL rather than by
    // its own URL: a script request made by the worker itself goes through
    // the host's service worker as a worker-destination request, which was
    // observed to hang without ever loading; the page's own fetch of the
    // same file works. The bundle is self-contained (its WebAssembly is
    // embedded), so nothing else is loaded from the worker side.
    const res = await fetch(opts.workerUrl);
    if (!res.ok) throw new Error(`software decoder bundle: ${res.status} ${res.statusText}`);
    const blobUrl = URL.createObjectURL(new Blob([await res.text()], { type: "text/javascript" }));
    return new Promise((resolve, reject) => {
      const worker = new Worker(blobUrl, { type: "module" });
      const timeout = window.setTimeout(() => {
        worker.terminate();
        reject(new Error("software decoder did not start"));
      }, 15000);
      worker.onmessage = (e: MessageEvent<{ type: string }>) => {
        if (e.data?.type === "decoderReady") {
          window.clearTimeout(timeout);
          URL.revokeObjectURL(blobUrl);
          resolve(new WasmRouter(worker, opts));
        }
      };
      worker.onerror = (e) => {
        window.clearTimeout(timeout);
        reject(new Error(e.message || "software decoder failed to load"));
      };
    });
  }

  tile(rect: TileRect): TileDecoder {
    const id = this.nextId++;
    const t = new WasmTile(id, rect, this.worker, this.opts, () => this.tiles.delete(id));
    this.tiles.set(id, t);
    return t;
  }

  close(): void {
    this.worker.terminate();
  }
}

class WasmTile implements TileDecoder {
  private seenKeyframe = false;
  private submittedAt: number[] = [];

  constructor(
    private readonly id: number,
    private readonly rect: TileRect,
    private readonly worker: Worker,
    private readonly opts: DecoderOptions,
    private readonly onClose: () => void,
  ) {}

  picture(pic: WorkerPicture): void {
    // Pictures come out in submission order; the decoded size is
    // macroblock-aligned, the tile rect carries the size to show.
    const started = this.submittedAt.shift();
    this.opts.onPicture(
      {
        kind: "i420",
        data: new Uint8Array(pic.data),
        codedWidth: pic.width,
        codedHeight: pic.height,
        width: Math.min(this.rect.w, pic.width),
        height: Math.min(this.rect.h, pic.height),
        rect: this.rect,
      },
      started === undefined ? 0 : performance.now() - started,
    );
  }

  decode(tile: FrameTile): void {
    if (!this.seenKeyframe) {
      if (!tile.keyframe) return;
      this.seenKeyframe = true;
    }
    this.submittedAt.push(performance.now());
    // tinyh264 decodes one NAL unit per message and its input buffer is 1 MB,
    // so a tile goes over as its NAL units, each in its own copy.
    for (const nal of splitNalUnits(tile.data)) {
      const copy = nal.slice().buffer;
      this.worker.postMessage({ type: "decode", renderStateId: this.id, data: copy, offset: 0, length: nal.length }, [copy]);
    }
  }

  close(): void {
    this.worker.postMessage({ type: "release", renderStateId: this.id });
    this.onClose();
  }
}
