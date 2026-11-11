// One viewer's WebSocket to rpc-host (remote-pc) through Perch's proxy. It
// speaks remote-pc's protocol (rpc/proto.ts) and translates to and from the
// in-page messages (messages.ts) viewer.tsx handles. The token goes first
// (nothing arrives before it), then Hello; feedback every 100 ms and a ping
// every second for the host's rate control; reconnect with backoff while
// enabled.
import { ClipKind, Codec as PageCodec, DisplayKind, QualityLevel, type CodecCap, type InputEvent, type Msg as PageMsg } from "../messages";
import type { ConnState, ConnectionHandlers, ConnectionStats } from "../connection";
import type { FileChunk, VideoFrame } from "../wire";
import * as P from "./proto";
import { resizeRgba, rgbaToPng } from "./png";
import { h264Size, hevcSize } from "./sps";

const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];
const FEEDBACK_MS = 100;
const PING_MS = 1000;
const STATS_MS = 1000;
/// Error codes the viewer shows specially.
const ERROR_REPLACED = 10;

/// The viewer's button numbers (1 left, 2 middle, 3 right, 4 back, 5
/// forward) as Linux BTN_* codes.
const BUTTONS: Record<number, number> = { 1: 0x110, 2: 0x112, 3: 0x111, 4: 0x113, 5: 0x114 };

/// Typed text (the phone keyboard) as key presses on a US layout: rpc-host
/// injects keys, not characters. [evdev code, shift].
const US: Record<string, [number, boolean]> = (() => {
  const m: Record<string, [number, boolean]> = {};
  const rows: [string, string, number][] = [
    ["1234567890-=", "!@#$%^&*()_+", 2],
    ["qwertyuiop[]", "QWERTYUIOP{}", 16],
    ["asdfghjkl;'`", 'ASDFGHJKL:"~', 30],
    ["\\zxcvbnm,./", "|ZXCVBNM<>?", 43],
  ];
  for (const [plain, shifted, first] of rows) {
    for (let i = 0; i < plain.length; i++) {
      m[plain[i]] = [first + i, false];
      m[shifted[i]] = [first + i, true];
    }
  }
  m[" "] = [57, false];
  m["\n"] = [28, false];
  m["\t"] = [15, false];
  return m;
})();
const SHIFT = 42;

const nowUs = () => Math.round(performance.now() * 1000);

export interface RpcOptions {
  /** The host's own bitrate setting (kbit/s): quality presets cap at shares of it. */
  maxKbps: number;
  /** The running host's port and token now (null: none runs), asked before
   * each reconnect: a Stop and Start makes a new token (and maybe port), and
   * a tab retrying with the old one would be refused forever. */
  current?: () => Promise<{ port: number; token: string } | null>;
  /** The host streams a desktop already running there (its size is its own). */
  attach?: boolean;
}

/** Clipboard images: at most 16 MB, sent in 256 KB pieces, ids with the top bit. */
const IMAGE_MAX = 16 * 1024 * 1024;
const IMAGE_CHUNK = 256 * 1024;
const IMAGE_BIT = 0x80000000;

export class RpcConnection {
  private ws: WebSocket | null = null;
  private enabled = false;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private tickTimer: number | null = null;
  private lastPing = 0;
  private lastStats = 0;
  private offsetUs = 0;
  private bestRttUs = Infinity;
  // Per feedback window: bytes, frame delays (µs, host clock).
  private fb = { bytes: 0, owdSum: 0, owdMax: -(2 ** 31), n: 0, lost: 0 };
  private win = { frames: 0, bytes: 0, decodeMs: 0, decodes: 0 };
  private lastFrame = 0;
  private codec: number = P.Codec.H264;
  /** The stream's size: from Welcome, then every keyframe's SPS. */
  private size = { width: 0, height: 0 };
  private clip = new P.Assembler(P.CLIP_MAX / P.CLIP_CHUNK + 1);
  private cursor = new P.Assembler(80);
  private clipId = 1;
  /** Keys the viewer holds down (ReleaseAll lets them go). */
  private held = new Set<number>();
  private buttons = new Set<number>();
  private penDown = false;
  /** This tab drives (until a Seat says otherwise): a follower's input
   * isn't sent (the host ignores it; Take over to use the desktop). */
  private driver = true;
  /** Chunks sent so far per file this tab sends. */
  private fileIndex = new Map<number, number>();
  /** Clipboard images coming in: their size and pieces. */
  private images = new Map<number, { size: number; parts: Uint8Array[]; got: number }>();
  private imageId = 1;
  /** The desktop's width (Seat): the followers' picture is smaller. */
  private desktopWidth = 0;
  state: ConnState = "closed";
  stats: ConnectionStats = { fps: 0, kbps: 0, decodeMs: 0, rttMs: 0, lost: 0 };

  private port: number;
  private token: string;
  private readonly handlers: ConnectionHandlers;
  private readonly opts: RpcOptions;

  constructor(port: number, token: string, handlers: ConnectionHandlers, opts: RpcOptions) {
    this.port = port;
    this.token = token;
    this.handlers = handlers;
    this.opts = opts;
  }

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

  private sendMsg(m: P.Msg): boolean {
    return this.sendRaw(P.wsControl(m));
  }

  /** A control message from the viewer, in remote-pc's terms. */
  send(msg: PageMsg): boolean {
    switch (msg.t) {
      case "DisplayRequest":
        return this.sendMsg({ t: "ModeRequest", width: msg.width, height: msg.height, hz: msg.refresh, scale: msg.scalePct });
      case "Quality": {
        // High: up to the host's own cap; medium and low: 40 and 15 % of it.
        const share = msg.level === QualityLevel.LOW ? 0.15 : msg.level === QualityLevel.MEDIUM ? 0.4 : 0;
        return this.sendMsg({ t: "RateCap", kbps: share ? Math.max(1000, Math.round(this.opts.maxKbps * share)) : 0 });
      }
      case "Pause":
        return this.sendMsg({ t: "Pause", on: msg.paused });
      case "KeyframeReq":
        return this.sendMsg({ t: "KeyframeRequest" });
      case "FileOffer":
        return this.sendMsg({ t: "FileOffer", id: msg.id, name: msg.name, size: msg.size, sha256: msg.sha256 });
      case "FileAccept":
        return this.sendMsg({ t: "FileAccept", id: msg.id });
      case "FileCancel":
        return this.sendMsg({ t: "FileCancel", id: msg.id, reason: msg.reason });
      case "FileDone":
        return this.sendMsg({ t: "FileDone", id: msg.id, ok: msg.ok });
      case "Clipboard": {
        if (msg.kind === ClipKind.PNG) return this.sendImage(msg.data);
        if (msg.kind !== ClipKind.TEXT) return false;
        const chunks = P.clipChunks(this.clipId++, new TextDecoder().decode(msg.data));
        if (!chunks) return false;
        let ok = true;
        for (const c of chunks) ok = this.sendMsg(c) && ok;
        return ok;
      }
      default:
        return false;
    }
  }

  /** Viewer input as evdev keys, buttons and the absolute pointer. */
  sendInput(e: InputEvent): boolean {
    if (!this.driver && e.t !== "ReleaseAll") return false;
    switch (e.t) {
      case "Key":
        if (e.down) this.held.add(e.code);
        else this.held.delete(e.code);
        return this.sendMsg({ t: "Key", code: e.code, down: e.down });
      case "Button": {
        const code = BUTTONS[e.button];
        if (!code) return false;
        if (e.down) this.buttons.add(code);
        else this.buttons.delete(code);
        return this.sendMsg({ t: "Button", code, down: e.down });
      }
      case "Abs":
        return this.sendMsg({ t: "MouseAbs", x: clamp16(e.x), y: clamp16(e.y) });
      case "Wheel":
        // The viewer's dx is positive leftwards; remote-pc's h rightwards.
        return this.sendMsg({ t: "Wheel", v: clampI16(e.dy), h: clampI16(-e.dx) });
      case "Text":
        return this.typeText(e.text);
      case "ReleaseAll": {
        for (const k of this.held) this.sendMsg({ t: "Key", code: k, down: false });
        for (const b of this.buttons) this.sendMsg({ t: "Button", code: b, down: false });
        this.held.clear();
        this.buttons.clear();
        return true;
      }
      case "Pen": {
        // A pen is the pointer, with contact as the left button.
        this.sendMsg({ t: "MouseAbs", x: clamp16(e.x), y: clamp16(e.y) });
        const contact = (e.flags & 2) !== 0;
        if (contact !== this.penDown) {
          this.penDown = contact;
          this.sendInput({ t: "Button", button: 1, down: contact });
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** Text from a phone keyboard or an IME: the host types the characters
   * themselves (any language, whatever the desktop's layout). With a key
   * held (a chord from the strip: Ctrl+C), real keys of a US layout. */
  private typeText(text: string): boolean {
    if (this.held.size === 0) {
      // ≤ 1000 bytes a message: 250 characters of at most 4 bytes.
      const chars = Array.from(text);
      for (let i = 0; i < chars.length; i += 250) this.sendMsg({ t: "Text", text: chars.slice(i, i + 250).join("") });
      return true;
    }
    for (const ch of text) {
      const k = US[ch];
      if (!k) continue; // outside a US keyboard: not typed
      const [code, shift] = k;
      if (shift) this.sendMsg({ t: "Key", code: SHIFT, down: true });
      this.sendMsg({ t: "Key", code, down: true });
      this.sendMsg({ t: "Key", code, down: false });
      if (shift) this.sendMsg({ t: "Key", code: SHIFT, down: false });
    }
    return true;
  }

  sendDatagram(_payload: Uint8Array): boolean {
    return false; // microphone, gamepads: not on rpc-host yet
  }

  /** A chunk of a file this tab sends (in order; the last says so). */
  sendFile(chunk: FileChunk): boolean {
    const index = this.fileIndex.get(chunk.id) ?? 0;
    if (chunk.last) this.fileIndex.delete(chunk.id);
    else this.fileIndex.set(chunk.id, index + 1);
    // The count is known at the last chunk (bulk: u32 max until then).
    const count = chunk.last ? index + 1 : 0xffffffff;
    return this.sendRaw(P.encodeBulk({ id: chunk.id, index, count, data: chunk.data }));
  }

  /** A PNG copied in this browser, to the desktop's clipboard. */
  private sendImage(png: Uint8Array): boolean {
    if (png.length > IMAGE_MAX) return false;
    const id = (IMAGE_BIT | this.imageId) >>> 0;
    this.imageId = (this.imageId + 2) & 0x7fffffff;
    if (!this.sendMsg({ t: "ClipPng", id, size: png.length })) return false;
    const count = Math.max(1, Math.ceil(png.length / IMAGE_CHUNK));
    for (let index = 0; index < count; index++) {
      if (!this.sendRaw(P.encodeBulk({ id, index, count, data: png.subarray(index * IMAGE_CHUNK, (index + 1) * IMAGE_CHUNK) }))) return false;
    }
    return true;
  }

  /** Ask for the driver's seat (a driver taking it back after a reconnect). */
  claim(): boolean {
    return this.sendMsg({ t: "TakeOver" });
  }

  bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  reportDecode(ms: number): void {
    this.win.decodeMs += ms;
    this.win.decodes += 1;
  }

  reportLost(): void {
    this.stats.lost += 1;
    this.fb.lost += 1;
  }

  private open(): void {
    this.clearTimers();
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${location.host}/proxy/${this.port}/ws`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      ws.send(this.token);
      // A new connection holds nothing down at the host.
      this.held.clear();
      this.buttons.clear();
      this.penDown = false;
      let decoders = P.Dec.AUDIO | P.Dec.CURSOR | P.Dec.CURSOR_POS | P.Dec.BULK;
      for (const c of this.handlers.decoders() as CodecCap[]) {
        if (c.codec === PageCodec.H264) decoders |= P.Dec.H264;
        if (c.codec === PageCodec.H265) decoders |= P.Dec.HEVC;
      }
      this.sendMsg({ t: "Hello", version: P.VERSION, name: `perch:${this.handlers.viewerId()}`, decoders, width: 0, height: 0, hz: 0, scale: 0 });
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
      this.reconnectTimer = window.setTimeout(() => void this.reopen(), delay);
    };
    ws.onerror = () => {
      // onclose follows and schedules the retry.
    };
  }

  /** Reconnect with the host's current port and token. */
  private async reopen(): Promise<void> {
    this.reconnectTimer = null;
    if (this.opts.current) {
      try {
        const now = await this.opts.current();
        if (now) {
          this.port = now.port;
          this.token = now.token;
        }
      } catch {
        // Perch itself is away: retry with what we have.
      }
    }
    // Stopped meanwhile, or another attempt already opened.
    if (!this.enabled || this.ws || this.reconnectTimer !== null) return;
    this.open();
  }

  private onMessage(data: unknown): void {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 1) return;
    const b = new Uint8Array(data);
    try {
      switch (b[0]) {
        case P.Chan.CONTROL: {
          const m = P.decodeMsg(b.subarray(1));
          if (m) this.onControl(m);
          return;
        }
        case P.Chan.BULK: {
          const k = P.decodeBulk(b);
          const img = this.images.get(k.id);
          if (img) {
            img.parts.push(k.data);
            img.got += k.data.length;
            if (img.got >= img.size) {
              this.images.delete(k.id);
              const png = new Uint8Array(img.size);
              let at = 0;
              for (const p of img.parts) {
                png.set(p.subarray(0, img.size - at), at);
                at += Math.min(p.length, img.size - at);
              }
              this.handlers.onControl({ t: "Clipboard", kind: ClipKind.PNG, data: png });
            }
          } else {
            this.handlers.onFile({ id: k.id, last: k.index + 1 === k.count, data: k.data });
          }
          return;
        }
        case P.Chan.VIDEO:
          this.onVideo(b);
          return;
        case P.Chan.AUDIO: {
          const a = P.decodeAudio(b);
          if (a.cur.length) this.handlers.onAudio({ seq: a.seq, tsUs: a.tCapture / 1000n, data: a.cur });
          return;
        }
        case P.Chan.PONG: {
          const p = P.decodePong(b);
          const now = nowUs();
          const rtt = Math.max(0, now - Number(p.pingUs));
          this.stats.rttMs = rtt / 1000;
          // Host clock minus page clock, from the fastest round trip.
          if (rtt <= this.bestRttUs * 1.2) {
            this.bestRttUs = Math.min(this.bestRttUs, rtt);
            this.offsetUs = Number(p.hostNs / 1000n) - (Number(p.pingUs) + rtt / 2);
          }
          return;
        }
        default:
          return;
      }
    } catch {
      // A malformed message: skipped.
    }
  }

  private onControl(m: P.Msg): void {
    const h = this.handlers;
    switch (m.t) {
      case "Welcome": {
        this.attempt = 0;
        this.codec = m.codec;
        this.size = { width: m.width, height: m.height };
        this.setState("open");
        this.startTicking();
        h.onControl({ t: "HelloAck", name: m.hostName });
        h.onControl({ t: "StreamStarted", stream: 0, codec: m.codec, width: m.width, height: m.height, fps: m.hz });
        // A private desktop follows the driver's size.
        h.onControl({ t: "DisplayInfo", stream: 0, kind: this.opts.attach ? DisplayKind.FIXED : DisplayKind.OWN, width: m.width, height: m.height, scalePct: 100, note: "" });
        h.onControl({ t: "CursorInfo", inPicture: false });
        // For the stats panel's "from <encoder>".
        h.onControl({ t: "HostStats", stream: 0, bitrateKbps: 0, fps: m.hz, encoder: `rpc-host VA-API ${m.codec === P.Codec.HEVC ? "H.265" : "H.264"}` });
        return;
      }
      case "ModeApplied":
        // The size comes from the stream's keyframes (their SPS): each
        // viewer's frames carry its own generation numbers, not this one's.
        return;
      case "Seat":
        if (this.driver && !m.driver) {
          // The host let go of what this tab held down.
          this.held.clear();
          this.buttons.clear();
          this.penDown = false;
        }
        this.driver = m.driver;
        this.desktopWidth = m.width;
        // In the picture only when a follower can't draw the driver's pointer
        // (an older native one); otherwise the driver draws its own and
        // followers get CursorPos.
        h.onSeat({ driver: m.driver, driverName: m.driverName, width: m.width, height: m.height, scalePct: m.scale || 100, driverRatioPct: m.scale || 100, viewers: m.viewers, cursorInPicture: m.inPicture });
        return;
      case "CursorPos":
        h.onCursorPos?.(m.x / 65535, m.y / 65535, this.desktopWidth > 0 && this.size.width > 0 ? this.size.width / this.desktopWidth : 1);
        return;
      case "FileOffer":
      case "FileAccept":
      case "FileCancel":
      case "FileDone":
        // The viewer's file transfer speaks the same four.
        h.onControl(m);
        return;
      case "ClipPng":
        if (m.size <= IMAGE_MAX) this.images.set(m.id, { size: m.size, parts: [], got: 0 });
        return;
      case "ClipChunk": {
        const all = this.clip.push(m.id, m.index, m.count, m.data);
        if (all) h.onControl({ t: "Clipboard", kind: ClipKind.TEXT, data: all });
        return;
      }
      case "CursorChunk": {
        const all = this.cursor.push(m.id, m.index, m.count, m.data);
        const c = all && P.decodeCursor(all);
        if (!c) return;
        // The shape is in desktop pixels; the viewer wants stream pixels.
        const s = (c.scaleMilli || 1000) / 1000;
        const w = Math.max(1, Math.round(c.width * s));
        const hh = Math.max(1, Math.round(c.height * s));
        const png = rgbaToPng(w, hh, resizeRgba(c.width, c.height, c.rgba, w, hh));
        h.onControl({ t: "Cursor", width: w, height: hh, xhot: Math.round(c.hotX * s), yhot: Math.round(c.hotY * s), png });
        return;
      }
      case "Bye": {
        // Not worth retrying: another codec or protocol is needed.
        if (m.reason === P.ByeReason.NO_CODEC || m.reason === P.ByeReason.VERSION) this.enabled = false;
        h.onControl({ t: "Error", code: m.reason === P.ByeReason.REPLACED ? ERROR_REPLACED : 0, text: m.text });
        return;
      }
      default:
        return;
    }
  }

  private onVideo(b: Uint8Array): void {
    const { hdr, au } = P.decodeVideo(b);
    const t = nowUs();
    this.fb.bytes += b.byteLength;
    if (this.bestRttUs < Infinity) {
      const owd = t + this.offsetUs - Number(hdr.tCapture / 1000n);
      this.fb.owdSum += owd;
      this.fb.owdMax = Math.max(this.fb.owdMax, owd);
      this.fb.n += 1;
    }
    this.win.frames += 1;
    this.win.bytes += b.byteLength;
    this.lastFrame = hdr.frame;
    // Size: every keyframe carries it (a new size starts with one).
    if (hdr.keyframe) {
      const s = hdr.codec === P.Codec.H264 ? h264Size(au) : hdr.codec === P.Codec.HEVC ? hevcSize(au) : null;
      if (s) this.size = s;
    }
    if (hdr.codec !== this.codec) this.codec = hdr.codec;
    const frame: VideoFrame = {
      stream: 0,
      keyframe: hdr.keyframe,
      au,
      meta: {
        codec: hdr.codec,
        flags: hdr.keyframe ? 1 : 0,
        width: this.size.width,
        height: this.size.height,
        len: au.length,
        captureUs: hdr.tCapture / 1000n,
        encodeStartUs: hdr.tCapture / 1000n,
        encodeEndUs: hdr.tCapture / 1000n,
        sendUs: hdr.tCapture / 1000n,
      },
    };
    this.handlers.onVideo(frame);
  }

  private startTicking(): void {
    if (this.tickTimer !== null) return;
    this.lastPing = 0;
    this.lastStats = performance.now();
    this.tickTimer = window.setInterval(() => this.tick(), FEEDBACK_MS);
  }

  private tick(): void {
    const f = this.fb;
    const clampI32 = (v: number) => Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, Math.round(v)));
    this.sendRaw(
      P.encodeFeedback({
        decoded: this.lastFrame >>> 0,
        dropped: Math.min(0xffff, f.lost),
        bytes: Math.min(0xffffffff, f.bytes),
        windowUs: FEEDBACK_MS * 1000,
        owdMeanUs: f.n ? clampI32(f.owdSum / f.n) : 0,
        owdMaxUs: f.n ? clampI32(f.owdMax) : 0,
        decodeQueue: 0,
      }),
    );
    this.fb = { bytes: 0, owdSum: 0, owdMax: -(2 ** 31), n: 0, lost: 0 };
    const now = performance.now();
    if (now - this.lastPing >= PING_MS) {
      this.lastPing = now;
      this.sendRaw(P.encodePing(BigInt(nowUs())));
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

const clamp16 = (v: number) => Math.max(0, Math.min(0xffff, Math.round(v)));
const clampI16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));
