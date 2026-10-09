// File transfer both ways over the gateway's file channel. A file dropped
// on the viewer is offered to the host (FileOffer with its SHA-256), sent
// in chunks once accepted, and confirmed by the host's FileDone. A file the
// host offers (its outbox) is accepted, collected and saved through a
// download link, then confirmed back.
import { type Msg } from "./qr/proto";
import type { FileChunk } from "./wire";

/** Bytes per chunk when sending. */
const CHUNK_BYTES = 256 * 1024;
/** Sending pauses while this much is queued on the socket. */
const SEND_HIGH_WATER = 4 * 1024 * 1024;

export interface FileTransport {
  send(msg: Msg): boolean;
  sendFile(chunk: FileChunk): boolean;
  /** Bytes the socket has not sent yet. */
  bufferedAmount(): number;
}

export interface FileTransferOptions {
  transport: FileTransport;
  /** A short line for the user: progress, done, or why not. */
  onNotice(text: string | null): void;
}

export interface FileTransfer {
  /** Offer a file from this browser to the host. */
  offer(file: File): Promise<void>;
  /** A control message that may belong to a transfer: true when consumed. */
  onControl(msg: Msg): boolean;
  /** A chunk of a file the host sends. */
  onChunk(chunk: FileChunk): void;
  /** Forget every transfer in flight (the connection went). */
  reset(): void;
}

async function sha256(data: ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

export function createFileTransfer(opts: FileTransferOptions): FileTransfer {
  const { transport } = opts;
  // Ids this side allocates are odd, the host's even (as its native client does).
  let nextId = 1;
  const outgoing = new Map<number, File>();
  const incoming = new Map<number, { name: string; size: number; sha256: Uint8Array; parts: Uint8Array[]; received: number }>();

  const notice = (text: string | null) => opts.onNotice(text);

  const sendBody = async (id: number, file: File) => {
    const reader = file.stream().getReader();
    let sent = 0;
    let pending = new Uint8Array(0);
    const flush = async (last: boolean) => {
      while (transport.bufferedAmount() > SEND_HIGH_WATER) await new Promise((r) => setTimeout(r, 20));
      if (!transport.sendFile({ id, last, data: pending })) throw new Error("the connection closed");
      sent += pending.length;
      pending = new Uint8Array(0);
      notice(`Sending ${file.name}: ${Math.round((sent / Math.max(1, file.size)) * 100)}%`);
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      let chunk = value;
      while (chunk.length) {
        const room = CHUNK_BYTES - pending.length;
        const take = chunk.subarray(0, room);
        const merged = new Uint8Array(pending.length + take.length);
        merged.set(pending);
        merged.set(take, pending.length);
        pending = merged;
        chunk = chunk.subarray(room);
        if (pending.length >= CHUNK_BYTES) await flush(false);
      }
    }
    await flush(true);
  };

  const save = (name: string, parts: Uint8Array[]) => {
    const blob = new Blob(parts as BlobPart[]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  };

  return {
    async offer(file: File) {
      const id = nextId;
      nextId += 2;
      outgoing.set(id, file);
      notice(`Preparing ${file.name}…`);
      const digest = await sha256(await file.arrayBuffer());
      if (!transport.send({ t: "FileOffer", id, name: file.name, size: BigInt(file.size), sha256: digest })) {
        outgoing.delete(id);
        notice("Not connected: the file was not sent.");
      }
    },
    onControl(msg: Msg): boolean {
      switch (msg.t) {
        case "FileAccept": {
          const file = outgoing.get(msg.id);
          if (!file) return false;
          sendBody(msg.id, file).catch((err) => {
            outgoing.delete(msg.id);
            notice(`Sending ${file.name} failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          return true;
        }
        case "FileDone": {
          const file = outgoing.get(msg.id);
          if (!file) return incoming.delete(msg.id);
          outgoing.delete(msg.id);
          notice(msg.ok ? `Sent ${file.name}.` : `The host's copy of ${file.name} did not match; try again.`);
          return true;
        }
        case "FileCancel": {
          const file = outgoing.get(msg.id);
          outgoing.delete(msg.id);
          incoming.delete(msg.id);
          notice(`${file ? file.name : "The file"}: ${msg.reason || "cancelled by the host"}.`);
          return true;
        }
        case "FileOffer": {
          incoming.set(msg.id, { name: msg.name, size: Number(msg.size), sha256: msg.sha256, parts: [], received: 0 });
          transport.send({ t: "FileAccept", id: msg.id });
          notice(`Receiving ${msg.name}…`);
          return true;
        }
        default:
          return false;
      }
    },
    onChunk(chunk: FileChunk) {
      const f = incoming.get(chunk.id);
      if (!f) return;
      if (chunk.data.length) {
        f.parts.push(chunk.data.slice());
        f.received += chunk.data.length;
        notice(`Receiving ${f.name}: ${Math.round((f.received / Math.max(1, f.size)) * 100)}%`);
      }
      if (!chunk.last) return;
      incoming.delete(chunk.id);
      const whole = new Blob(f.parts as BlobPart[]);
      whole
        .arrayBuffer()
        .then(sha256)
        .then((digest) => {
          const ok = sameBytes(digest, f.sha256);
          if (ok) save(f.name, f.parts);
          transport.send({ t: "FileDone", id: chunk.id, ok });
          notice(ok ? `Received ${f.name}.` : `${f.name} arrived damaged and was discarded.`);
        })
        .catch(() => {
          transport.send({ t: "FileDone", id: chunk.id, ok: false });
          notice(`${f.name} could not be checked.`);
        });
    },
    reset() {
      outgoing.clear();
      incoming.clear();
    },
  };
}
