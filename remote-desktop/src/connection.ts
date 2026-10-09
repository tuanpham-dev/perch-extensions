// One viewer's WebSocket to qr-host's gateway through Perch's proxy: the
// channel framing (wire.ts), the Hello, feedback every 50 ms and a ping
// every second for the host's rate control, per-second stats, and
// reconnect with backoff while enabled.
import { PROTO_MAJOR, PROTO_MINOR, decodeMsg, encodeInput, encodeMsg, type CodecCap, type InputEvent, type Msg } from "./qr/proto";
import {
  Channel,
  claimMessage,
  decodeFileChunk,
  decodeSeatMessage,
  fileMessage,
  parseVideo,
  wrap,
  type FileChunk,
  type Seat,
  type VideoFrame,
} from "./wire";

const controlMessage = (m: Msg) => wrap(Channel.CONTROL, encodeMsg(m));
const inputMessage = (e: InputEvent) => wrap(Channel.INPUT, encodeInput(e));

export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectionHandlers {
  /** Formats this browser decodes, best first. */
  decoders(): CodecCap[];
  /** This tab's identity, so a driver that reconnects can claim its seat. */
  viewerId(): string;
  /** Every control message from the host (Pong is also handled here). */
  onControl(msg: Msg): void;
  onSeat(seat: Seat): void;
  onVideo(frame: VideoFrame): void;
  /** A datagram with its kind byte first (audio, microphone, pad...). */
  onDatagram(payload: Uint8Array): void;
  onFile(chunk: FileChunk): void;
  onState(state: ConnState, attempt: number): void;
}

export interface ConnectionStats {
  fps: number;
  kbps: number;
  decodeMs: number;
  rttMs: number;
  /** Frames the decoder could not use (a keyframe was asked for). */
  lost: number;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000];
const FEEDBACK_MS = 50;
const PING_MS = 1000;
const STATS_MS = 1000;

const nowUs = () => Math.round(performance.now() * 1000);

export class Connection {
  private ws: WebSocket | null = null;
  private enabled = false;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private tickTimer: number | null = null;
  private pingSeq = 0;
  private feedbackSeq = 0;
  private lastPing = 0;
  private lastStats = 0;
  // Per feedback window.
  private fb = { bytes: 0, frames: 0, delays: [] as [number, number][] };
  // Per stats window.
  private win = { frames: 0, bytes: 0, decodeMs: 0, decodes: 0 };
  // Decode time over the current feedback window: the host lowers the
  // frame rate when a frame takes longer to decode than its slot.
  private fbDecodeMs = 0;
  private fbDecodes = 0;
  private offsetUs = 0;
  private bestRttUs = Infinity;
  state: ConnState = "closed";
  stats: ConnectionStats = { fps: 0, kbps: 0, decodeMs: 0, rttMs: 0, lost: 0 };

  constructor(
    private readonly port: number,
    private readonly handlers: ConnectionHandlers,
  ) {}

  start(): void {
    this.enabled = true;
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    this.enabled = false;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.setState("closed");
  }

  private sendRaw(bytes: Uint8Array): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(bytes);
    return true;
  }

  send(msg: Msg): boolean {
    return this.sendRaw(controlMessage(msg));
  }

  sendInput(e: InputEvent): boolean {
    return this.sendRaw(inputMessage(e));
  }

  sendDatagram(payload: Uint8Array): boolean {
    return this.sendRaw(wrap(Channel.DATAGRAM, payload));
  }

  sendFile(chunk: FileChunk): boolean {
    return this.sendRaw(fileMessage(chunk));
  }

  /** Ask for the driver's seat. */
  claim(): boolean {
    return this.sendRaw(claimMessage(this.handlers.viewerId()));
  }

  bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /** Decode time of one frame, for the stats panel. */
  reportDecode(ms: number): void {
    this.win.decodeMs += ms;
    this.win.decodes += 1;
    this.fbDecodeMs += ms;
    this.fbDecodes += 1;
  }

  /** The decoder dropped a frame it could not use. */
  reportLost(): void {
    this.stats.lost += 1;
  }

  private open(): void {
    this.clearTimers();
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/proxy/${this.port}/ws`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.send({
        t: "Hello",
        major: PROTO_MAJOR,
        minor: PROTO_MINOR,
        name: `perch:${this.handlers.viewerId()}`,
        os: navigator.platform || "web",
        wantWidth: 0,
        wantHeight: 0,
        wantRefresh: 0,
        decoders: this.handlers.decoders(),
      });
    };
    ws.onmessage = (e: MessageEvent) => this.onMessage(e.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (!this.enabled) {
        this.setState("closed");
        return;
      }
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
      this.attempt += 1;
      this.setState("reconnecting");
      this.reconnectTimer = window.setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => {
      // onclose follows and schedules the retry.
    };
  }

  private onMessage(data: unknown): void {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 1) return;
    const bytes = new Uint8Array(data);
    const payload = bytes.subarray(1);
    switch (bytes[0]) {
      case Channel.CONTROL: {
        let msg: Msg;
        try {
          msg = decodeMsg(payload);
        } catch {
          return;
        }
        if (msg.t === "HelloAck") {
          this.attempt = 0;
          this.setState("open");
          this.startTicking();
        } else if (msg.t === "Pong") {
          const now = nowUs();
          const rtt = Math.max(0, now - Number(msg.tClient));
          this.stats.rttMs = rtt / 1000;
          // Host clock minus page clock, from the pong with the least
          // round-trip: frame delays are then reported on the host's clock,
          // small numbers that fit the feedback's fields.
          if (rtt <= this.bestRttUs * 1.2) {
            this.bestRttUs = Math.min(this.bestRttUs, rtt);
            this.offsetUs = Number(msg.tHost) - (Number(msg.tClient) + rtt / 2);
          }
        }
        this.handlers.onControl(msg);
        return;
      }
      case Channel.VIDEO: {
        const frame = parseVideo(payload);
        if (!frame) return;
        const t = nowUs();
        this.fb.bytes += bytes.byteLength;
        this.fb.frames += 1;
        if (this.bestRttUs < Infinity) this.fb.delays.push([t, t + this.offsetUs - Number(frame.meta.sendUs)]);
        this.win.frames += 1;
        this.win.bytes += bytes.byteLength;
        this.handlers.onVideo(frame);
        return;
      }
      case Channel.DATAGRAM:
        this.handlers.onDatagram(payload);
        return;
      case Channel.FILE:
        try {
          this.handlers.onFile(decodeFileChunk(payload));
        } catch {
          // malformed chunk
        }
        return;
      case Channel.SEAT:
        try {
          const m = decodeSeatMessage(payload);
          if (m.t === "Seat") this.handlers.onSeat(m);
        } catch {
          // malformed seat message
        }
        return;
      default:
        return;
    }
  }

  private startTicking(): void {
    if (this.tickTimer !== null) return;
    this.lastPing = performance.now();
    this.lastStats = performance.now();
    this.tickTimer = window.setInterval(() => this.tick(), FEEDBACK_MS);
  }

  private tick(): void {
    const d = this.fb.delays;
    this.feedbackSeq += 1;
    this.send({
      t: "Feedback",
      seq: this.feedbackSeq,
      windowMs: FEEDBACK_MS,
      bytesRx: Math.min(this.fb.bytes, 0xffffffff),
      shardsRx: this.fb.frames,
      shardsLost: 0,
      shardsRepaired: 0,
      framesRx: Math.min(this.fb.frames, 0xffff),
      framesLost: 0,
      delayMinUs: d.length ? Math.round(Math.min(...d.map((x) => x[1])) % 2 ** 31) : 0,
      delayMaxUs: d.length ? Math.round(Math.max(...d.map((x) => x[1])) % 2 ** 31) : 0,
      delaySlope: slope(d),
      decodeUs: this.fbDecodes ? Math.min(0xffffffff, Math.round((this.fbDecodeMs / this.fbDecodes) * 1000)) : 0,
      presentUs: 0,
    });
    this.fb = { bytes: 0, frames: 0, delays: [] };
    this.fbDecodeMs = 0;
    this.fbDecodes = 0;
    const now = performance.now();
    if (now - this.lastPing >= PING_MS) {
      this.lastPing = now;
      this.send({ t: "Ping", seq: ++this.pingSeq, tClient: BigInt(nowUs()) });
    }
    if (now - this.lastStats >= STATS_MS) {
      const seconds = Math.max(0.001, (now - this.lastStats) / 1000);
      this.lastStats = now;
      this.stats = {
        fps: this.win.frames / seconds,
        kbps: (this.win.bytes * 8) / seconds / 1000,
        decodeMs: this.win.decodes ? this.win.decodeMs / this.win.decodes : 0,
        rttMs: this.stats.rttMs,
        lost: this.stats.lost,
      };
      this.win = { frames: 0, bytes: 0, decodeMs: 0, decodes: 0 };
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private setState(state: ConnState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState(state, this.attempt);
  }
}

// Least-squares slope of transit delay over time, in µs per second.
function slope(d: [number, number][]): number {
  if (d.length < 3) return 0;
  const t0 = d[0][0];
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [t, y] of d) {
    const x = (t - t0) / 1e6;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const n = d.length;
  const den = n * sxx - sx * sx;
  return den === 0 ? 0 : Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, Math.round((n * sxy - sx * sy) / den)));
}
