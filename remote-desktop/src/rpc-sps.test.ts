// H.265 sizes from real SPS NALs (rpc-va's VA-API encoder, via its
// sps_dump example): coded sizes padded to 64, cropped by the conformance
// window back to the mode.
import assert from "node:assert/strict";
import test from "node:test";
import { hevcSize } from "./rpc/sps.ts";

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)));
const au = (sps: string) => hex("00000001" + sps + "00000001" + "2601af");

test("hevc sizes from the SPS", () => {
  const cases: [string, number, number][] = [
    ["42010101600000030090000003000003007ba0050200481c6c2d8d97924294226a02020208000003000800000301e040", 616, 1110],
    ["42010101600000030090000003000003007ba00e080301c291f8d97924294226a020202080000003008000001e0400", 410, 740],
    ["42010101600000030090000003000003007ba003c0801107cb8d97924294226a02020208000003000800000301e04000", 1920, 1080],
    ["42010101600000030090000003000003007ba0068200601cd0ee365e490a5089a80808082000000300200000078100", 822, 1480],
  ];
  for (const [sps, w, h] of cases) assert.deepEqual(hevcSize(au(sps)), { width: w, height: h });
  assert.equal(hevcSize(hex("000000012601af")), null, "no SPS");
  assert.equal(hevcSize(hex("00000001420101")), null, "truncated");
});
