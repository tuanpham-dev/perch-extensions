// The picture size in a keyframe's sequence parameter set (H.264 or
// H.265), so the viewer sizes its canvas from the stream itself
// (remote-pc's video header carries no size, and the mode message's
// generation can't be relied on: a stream that restarts moves it on).

class Bits {
  private pos = 0;
  private b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  bit(): number {
    const byte = this.b[this.pos >> 3];
    if (byte === undefined) throw new Error("sps truncated");
    const v = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 31) throw new Error("bad exp-golomb");
    }
    return (1 << zeros) - 1 + this.bits(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -k / 2;
  }
}

/** The SPS NAL's payload with emulation-prevention bytes removed. */
function unescape(nal: Uint8Array): Uint8Array {
  const out = new Uint8Array(nal.length);
  let n = 0;
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out[n++] = nal[i];
  }
  return out.subarray(0, n);
}

function skipScalingList(r: Bits, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

/** Width and height of an H.264 access unit's SPS (Annex B), or null. */
export function h264Size(au: Uint8Array): { width: number; height: number } | null {
  for (let i = 0; i + 4 < au.length; i++) {
    if (au[i] !== 0 || au[i + 1] !== 0 || au[i + 2] !== 1 || (au[i + 3] & 0x1f) !== 7) continue;
    let end = au.length;
    for (let j = i + 4; j + 2 < au.length; j++) {
      if (au[j] === 0 && au[j + 1] === 0 && (au[j + 2] === 1 || au[j + 2] === 0)) {
        end = j;
        break;
      }
    }
    try {
      const r = new Bits(unescape(au.subarray(i + 4, end)));
      const profile = r.bits(8);
      r.bits(16); // constraints, level
      r.ue(); // sps id
      let chroma = 1;
      if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
        chroma = r.ue();
        if (chroma === 3) r.bit();
        r.ue();
        r.ue();
        r.bit();
        if (r.bit()) for (let k = 0; k < (chroma !== 3 ? 8 : 12); k++) if (r.bit()) skipScalingList(r, k < 6 ? 16 : 64);
      }
      r.ue(); // log2_max_frame_num
      const pocType = r.ue();
      if (pocType === 0) r.ue();
      else if (pocType === 1) {
        r.bit();
        r.se();
        r.se();
        const n = r.ue();
        for (let k = 0; k < n; k++) r.se();
      }
      r.ue(); // max_num_ref_frames
      r.bit();
      const wMbs = r.ue() + 1;
      const hMapUnits = r.ue() + 1;
      const frameMbsOnly = r.bit();
      if (!frameMbsOnly) r.bit();
      r.bit();
      let [cl, cr, ct, cb] = [0, 0, 0, 0];
      if (r.bit()) [cl, cr, ct, cb] = [r.ue(), r.ue(), r.ue(), r.ue()];
      const subW = chroma === 1 || chroma === 2 ? 2 : 1;
      const subH = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
      const width = wMbs * 16 - subW * (cl + cr);
      const height = (2 - frameMbsOnly) * hMapUnits * 16 - subH * (ct + cb);
      return width > 0 && height > 0 ? { width, height } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Skips an H.265 profile_tier_level with `maxSubLayersMinus1`. */
function skipPtl(r: Bits, maxSubLayersMinus1: number): void {
  r.bits(8); // profile space, tier, profile idc
  r.bits(32); // compatibility flags
  r.bits(24); // progressive, interlaced, non-packed, frame-only + 20 of the 43 reserved bits
  r.bits(24); // the other 23 reserved bits + inbld/reserved
  r.bits(8); // level idc
  const profile: boolean[] = [];
  const level: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profile.push(r.bit() === 1);
    level.push(r.bit() === 1);
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.bits(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profile[i]) {
      r.bits(32);
      r.bits(32);
      r.bits(24);
    }
    if (level[i]) r.bits(8);
  }
}

/** Width and height of an H.265 access unit's SPS (Annex B), or null. */
export function hevcSize(au: Uint8Array): { width: number; height: number } | null {
  for (let i = 0; i + 5 < au.length; i++) {
    if (au[i] !== 0 || au[i + 1] !== 0 || au[i + 2] !== 1 || ((au[i + 3] >> 1) & 0x3f) !== 33) continue;
    let end = au.length;
    for (let j = i + 5; j + 2 < au.length; j++) {
      if (au[j] === 0 && au[j + 1] === 0 && (au[j + 2] === 1 || au[j + 2] === 0)) {
        end = j;
        break;
      }
    }
    try {
      const r = new Bits(unescape(au.subarray(i + 5, end)));
      r.bits(4); // vps id
      const maxSub = r.bits(3);
      r.bit();
      skipPtl(r, maxSub);
      r.ue(); // sps id
      const chroma = r.ue();
      if (chroma === 3) r.bit();
      let width = r.ue();
      let height = r.ue();
      if (r.bit()) {
        const [cl, cr, ct, cb] = [r.ue(), r.ue(), r.ue(), r.ue()];
        const subW = chroma === 1 || chroma === 2 ? 2 : 1;
        const subH = chroma === 1 ? 2 : 1;
        width -= subW * (cl + cr);
        height -= subH * (ct + cb);
      }
      return width > 0 && height > 0 ? { width, height } : null;
    } catch {
      return null;
    }
  }
  return null;
}
