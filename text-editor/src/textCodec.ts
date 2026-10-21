// How a file's bytes become editor text and back. UTF-8 (with or without a
// byte-order mark) is read as UTF-8; anything that isn't valid UTF-8 is read
// as Latin-1, where every byte is one character. A save writes the text back
// the same way it was read, BOM included, so a Latin-1 file that was opened
// and saved unchanged comes back byte for byte.

export interface FileEncoding {
  charset: "utf-8" | "latin1";
  bom: boolean;
}

export const UTF8: FileEncoding = { charset: "utf-8", bom: false };

const BOM = [0xef, 0xbb, 0xbf];

function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2];
}

export function decodeBytes(bytes: Uint8Array): { text: string; encoding: FileEncoding } {
  if (hasBom(bytes)) {
    // ignoreBOM keeps the decoder from eating it twice; it's sliced off here.
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(3));
    return { text, encoding: { charset: "utf-8", bom: true } };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, encoding: UTF8 };
  } catch {
    // Not UTF-8. TextDecoder's "latin1" is really windows-1252 (0x80-0x9f map
    // elsewhere), which wouldn't round-trip, so each byte is mapped by hand.
    let text = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return { text, encoding: { charset: "latin1", bom: false } };
  }
}

export function encodeText(text: string, encoding: FileEncoding): Uint8Array<ArrayBuffer> {
  if (encoding.charset === "latin1") {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 0xff) {
        throw new Error(`This file is Latin-1 and "${text[i]}" can't be saved in it - remove it, or convert the file to UTF-8.`);
      }
      out[i] = code;
    }
    return out;
  }
  const body = new TextEncoder().encode(text);
  if (!encoding.bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set(BOM, 0);
  out.set(body, 3);
  return out;
}
