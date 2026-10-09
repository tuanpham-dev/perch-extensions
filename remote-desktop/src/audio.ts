// The desktop's sound: Opus packets (48 kHz stereo) decoded with WebCodecs
// and scheduled 20 ms ahead on an AudioContext. Ported from quick-remote
// web/src/main.ts. Browsers only let sound start from a user gesture, so
// the pipe is created inside the toolbar button's click handler.
import type { AudioPacket } from "./qr/proto";

export class AudioPipe {
  private readonly ctx: AudioContext;
  private readonly dec: AudioDecoder;
  private next = 0;
  /** Packets handed to the decoder since the pipe started. */
  packets = 0;

  static supported(): boolean {
    return typeof AudioDecoder !== "undefined" && typeof AudioContext !== "undefined";
  }

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    this.dec = new AudioDecoder({
      output: (d) => {
        const buf = this.ctx.createBuffer(d.numberOfChannels, d.numberOfFrames, d.sampleRate);
        for (let c = 0; c < d.numberOfChannels; c++) {
          const ch = new Float32Array(d.numberOfFrames);
          d.copyTo(ch, { planeIndex: c, format: "f32-planar" });
          buf.copyToChannel(ch, c);
        }
        d.close();
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        const t = this.ctx.currentTime;
        if (this.next < t + 0.005 || this.next > t + 0.1) this.next = t + 0.02;
        src.start(this.next);
        this.next += buf.duration;
      },
      error: () => {
        // A bad packet: the next one carries on.
      },
    });
    this.dec.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
  }

  /** Resumes the context (a tab that was hidden may have suspended it). */
  resume(): void {
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  push(a: AudioPacket): void {
    if (a.mic || this.dec.state !== "configured") return;
    this.packets += 1;
    try {
      this.dec.decode(new EncodedAudioChunk({ type: "key", timestamp: a.seq * 5000, data: a.data }));
    } catch {
      // The decoder refused the chunk; the next packet carries on.
    }
  }

  close(): void {
    try {
      this.dec.close();
    } catch {
      // already closed
    }
    void this.ctx.close().catch(() => {});
  }
}
