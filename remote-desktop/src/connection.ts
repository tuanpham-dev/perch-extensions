// What the viewer and the rpc-host adapter (rpc/connection.ts) share:
// the connection's state, the handlers it calls and its stats.
import type { AudioPacket, CodecCap, Msg } from "./messages";
import type { FileChunk, VideoFrame } from "./wire";

/** Who drives and how many watch (from the host's Seat). */
export interface Seat {
  driver: boolean;
  /** Who drives, and the desktop's size (not this tab's stream: a
   * follower watches a lighter one). */
  driverName: string;
  width: number;
  height: number;
  scalePct: number;
  driverRatioPct: number;
  viewers: number;
  cursorInPicture: boolean;
}

export type ConnState = "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectionHandlers {
  /** Formats this browser decodes, best first. */
  decoders(): CodecCap[];
  /** This tab's identity, so a driver that reconnects can claim its seat. */
  viewerId(): string;
  /** Every control message from the host (Pong is also handled here). */
  onControl(msg: Msg): void;
  onSeat(seat: Seat): void;
  /** Following: where the driver's pointer is, as fractions of the picture
   * (rpc-host; the pointer is out of the picture and this tab draws it),
   * and the picture's pixels per desktop pixel (the followers' stream is
   * smaller than the desktop: the pointer shape shrinks with it). */
  onCursorPos?(fx: number, fy: number, pictureScale: number): void;
  onVideo(frame: VideoFrame): void;
  /** The desktop's sound. */
  onAudio(packet: AudioPacket): void;
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
