import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Sha256 } from "./sha256.ts";

test("sha256 in pieces matches node's", () => {
  const data = new Uint8Array(300_001).map((_, i) => (i * 31 + (i >> 7)) & 255);
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, data.length]) {
    const want = createHash("sha256").update(data.subarray(0, n)).digest("hex");
    for (const piece of [1, 7, 64, 4096, 1 << 20]) {
      const h = new Sha256();
      for (let i = 0; i < n; i += piece) h.update(data.subarray(i, Math.min(n, i + piece)));
      assert.equal(Buffer.from(h.digest()).toString("hex"), want, `n=${n} piece=${piece}`);
    }
  }
});
