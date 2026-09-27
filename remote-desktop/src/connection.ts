// One viewer's WebSocket to quicdesk-server through Perch's proxy: hello,
// JSON control messages, binary frames, ping/stats every 2 s, frame-gap
// detection, and reconnect with backoff while enabled.
import {
  parseFrame,
  type ParsedFrame,
  WS_PROTOCOL_VERSION,
  type ClientMsg,
  type ServerHello,
  type ServerMsg,
} from "./wire";

export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectionHandlers {
  requestedSize(): { width: number; height: number };
  pixelRatio(): number;
  onHello(hello: ServerHello): void;
  onFrame(frame: ParsedFrame): void;
  onMessage(msg: ServerMsg): void;
  onState(state: ConnState, attempt: number): void;
}

export interface ConnectionStats {
  fps: number;
  kbps: number;
  decodeMs: number;
  rttMs: number;
  gaps: number;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000];
const REPORT_INTERVAL_MS = 2000;

export class Connection {
  private ws: WebSocket | null = null;
  private enabled = false;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private reportTimer: number | null = null;
  private pingSeq = 0;
  private lastFrameId = -1;
  private gapsTotal = 0;
  private windowFrames = 0;
  private windowBytes = 0;
  private windowDecodeMs = 0;
  private windowDecodes = 0;
  private windowStart = performance.now();
  state: ConnState = "closed";
  stats: ConnectionStats = { fps: 0, kbps: 0, decodeMs: 0, rttMs: 0, gaps: 0 };

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

  send(msg: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Decode time of one frame, for the stats the server adapts on. */
  reportDecode(ms: number): void {
    this.windowDecodeMs += ms;
    this.windowDecodes += 1;
  }

  private open(): void {
    this.clearTimers();
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/proxy/${this.port}/ws`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      const size = this.handlers.requestedSize();
      this.lastFrameId = -1;
      this.send({
        t: "hello",
        version: WS_PROTOCOL_VERSION,
        name: "perch",
        width: size.width,
        height: size.height,
        pixelRatio: this.handlers.pixelRatio(),
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
    if (typeof data === "string") {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(data) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === "hello") {
        this.attempt = 0;
        this.setState("open");
        this.startReporting();
        this.handlers.onHello(msg);
        return;
      }
      if (msg.t === "pong") {
        this.stats.rttMs = Math.max(0, performance.now() - msg.sent);
      }
      this.handlers.onMessage(msg);
      return;
    }
    if (data instanceof ArrayBuffer) {
      const frame = parseFrame(data);
      if (!frame) return;
      const header = frame.header;
      if (this.lastFrameId >= 0 && header.frameId > this.lastFrameId + 1) {
        this.gapsTotal += 1;
        this.send({ t: "keyframe" });
      }
      this.lastFrameId = header.frameId;
      this.windowFrames += 1;
      this.windowBytes += data.byteLength;
      this.handlers.onFrame(frame);
    }
  }

  private startReporting(): void {
    if (this.reportTimer !== null) return;
    this.windowStart = performance.now();
    this.reportTimer = window.setInterval(() => {
      const now = performance.now();
      const seconds = Math.max(0.001, (now - this.windowStart) / 1000);
      this.stats = {
        fps: this.windowFrames / seconds,
        kbps: (this.windowBytes * 8) / seconds / 1000,
        decodeMs: this.windowDecodes ? this.windowDecodeMs / this.windowDecodes : 0,
        rttMs: this.stats.rttMs,
        gaps: this.gapsTotal,
      };
      this.send({ t: "stats", fps: this.stats.fps, decodeMs: this.stats.decodeMs, gaps: this.gapsTotal });
      this.send({ t: "ping", seq: ++this.pingSeq, sent: now });
      this.windowFrames = 0;
      this.windowBytes = 0;
      this.windowDecodeMs = 0;
      this.windowDecodes = 0;
      this.windowStart = now;
    }, REPORT_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reportTimer !== null) {
      window.clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
  }

  private setState(state: ConnState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState(state, this.attempt);
  }
}
