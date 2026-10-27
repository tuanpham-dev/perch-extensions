// Reading a transcript the way it grows. Claude Code only ever appends to
// its JSONL files, and the live ones run to hundreds of MB, so re-reading
// them on every refresh kept Perch's server busy for seconds at a time (the
// server shares one thread with every terminal, so typing lagged with it).
// Instead each refresh reads only the bytes written since the last one, in
// chunks the event loop gets a turn between.
import { open } from "node:fs/promises";

export const CHUNK_BYTES = 4 * 1024 * 1024;

// Hands `onText` the whole lines written to `filePath` between byte `from`
// and `size`, a chunk at a time, and returns the offset just past the last
// whole line: a line still being written is left for the next read, and a
// chunk never splits a multi-byte character, since it ends on a newline.
// Returns null when the file can't be read at all; one that fails partway
// returns how far it got, so the lines already handed over aren't again.
export async function readAppendedLines(filePath, from, size, onText, chunkBytes = CHUNK_BYTES) {
  if (size <= from) return from;
  let handle;
  let offset = from;
  try {
    handle = await open(filePath, "r");
    let carry = Buffer.alloc(0);
    for (let position = from; position < size; ) {
      const length = Math.min(chunkBytes, size - position);
      const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(length), position });
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length > 0 ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      const end = data.lastIndexOf(0x0a);
      if (end === -1) {
        carry = data;
        continue;
      }
      onText(data.subarray(0, end + 1).toString("utf8"));
      offset += end + 1;
      carry = data.subarray(end + 1);
    }
    return offset;
  } catch {
    return offset > from ? offset : null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
