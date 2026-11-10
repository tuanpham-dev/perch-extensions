// RGBA pixels to a PNG (uncompressed deflate blocks), for cursor shapes:
// remote-pc sends raw RGBA, and the viewer shows cursors as PNG images.
// Small shapes only (≤ 128×128), so no compression is needed.

let crcTable: Uint32Array | null = null;

function crc32(b: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function rgbaToPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  // Scanlines with filter byte 0.
  const row = width * 4 + 1;
  const raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * row + 1);
  // zlib: header, stored blocks of ≤ 65535 bytes, Adler-32.
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  let at = 2;
  for (let i = 0; i < blocks; i++) {
    const part = raw.subarray(i * 65535, Math.min(raw.length, (i + 1) * 65535));
    z[at++] = i === blocks - 1 ? 1 : 0;
    z[at++] = part.length & 0xff;
    z[at++] = part.length >>> 8;
    z[at++] = ~part.length & 0xff;
    z[at++] = (~part.length >>> 8) & 0xff;
    z.set(part, at);
    at += part.length;
  }
  let a = 1;
  let b = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = ((b << 16) | a) >>> 0;
  z[at++] = adler >>> 24;
  z[at++] = (adler >>> 16) & 0xff;
  z[at++] = (adler >>> 8) & 0xff;
  z[at++] = adler & 0xff;

  const chunks: [string, Uint8Array][] = [];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  chunks.push(["IHDR", ihdr], ["IDAT", z.subarray(0, at)], ["IEND", new Uint8Array(0)]);
  const size = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0);
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const odv = new DataView(out.buffer);
  let p = 8;
  for (const [type, data] of chunks) {
    odv.setUint32(p, data.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(data, p + 8);
    odv.setUint32(p + 8 + data.length, crc32(out, p + 4, p + 8 + data.length));
    p += 12 + data.length;
  }
  return out;
}

/** Nearest-neighbour resize (a cursor shown at the stream's scale). */
export function resizeRgba(w: number, h: number, rgba: Uint8Array, nw: number, nh: number): Uint8Array {
  if (nw === w && nh === h) return rgba;
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / nh));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / nw));
      out.set(rgba.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * nw + x) * 4);
    }
  }
  return out;
}
