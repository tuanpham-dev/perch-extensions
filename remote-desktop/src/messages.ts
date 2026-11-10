// The messages the viewer and the rpc-host adapter (rpc/connection.ts)
// exchange inside the page: what the host reported, what the tab asks of
// it, and input. They are in-page shapes only; rpc/proto.ts holds
// rpc-host's own wire encoding, which the adapter translates to and from.

export const Codec = { H264: 1, H265: 2 } as const;
export const ClipKind = { TEXT: 1, PNG: 2 } as const;

/** A format this browser decodes. */
export interface CodecCap { codec: number; hw: boolean; maxWidth: number; maxHeight: number }

export interface HostStats {
  stream: number; bitrateKbps: number; fps: number; encoder: string;
}

export type Msg =
  | { t: "HelloAck"; name: string }
  | { t: "StreamStarted"; stream: number; codec: number; width: number; height: number; fps: number }
  | { t: "KeyframeReq"; stream: number }
  | { t: "Clipboard"; kind: number; data: Uint8Array }
  | { t: "FileOffer"; id: number; name: string; size: bigint; sha256: Uint8Array }
  | { t: "FileAccept"; id: number }
  | { t: "FileCancel"; id: number; reason: string }
  | { t: "FileDone"; id: number; ok: boolean }
  | ({ t: "HostStats" } & HostStats)
  | { t: "Error"; code: number; text: string }
  | { t: "DisplayRequest"; stream: number; width: number; height: number; refresh: number; scalePct: number; target: number }
  | { t: "DisplayInfo"; stream: number; kind: number; width: number; height: number; scalePct: number; note: string }
  | { t: "Pause"; paused: boolean }
  | { t: "Quality"; level: number }
  | { t: "CursorInfo"; inPicture: boolean }
  | { t: "Cursor"; width: number; height: number; xhot: number; yhot: number; png: Uint8Array };

/** `DisplayInfo.kind`: a desktop of its own size (attached) or one that
 * follows the driver (the host's own). */
export const DisplayKind = { FIXED: 0, OWN: 1 } as const;
/** `DisplayRequest.target`. */
export const DisplayTarget = { VIRTUAL: 0 } as const;
export const QualityLevel = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;

export type InputEvent =
  | { t: "Key"; code: number; down: boolean }
  | { t: "Button"; button: number; down: boolean }
  | { t: "Abs"; stream: number; x: number; y: number }
  | { t: "Wheel"; dx: number; dy: number }
  | { t: "Text"; text: string }
  | { t: "ReleaseAll" }
  | { t: "Pen"; stream: number; x: number; y: number; pressure: number; tiltX: number; tiltY: number; flags: number };

/** An Opus packet of the desktop's sound. */
export interface AudioPacket { seq: number; tsUs: bigint; data: Uint8Array }
