// macOS memory from vm_stat. Node's os.freemem() there counts only free pages,
// which made a healthy Mac read as nearly full; these pin the reading that
// replaced it, against vm_stat's own output.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryFromVmStat, parseSwapUsage, parseVmStat } from "../memory.mjs";

// `vm_stat` on an Apple silicon Mac with 16 GB (16 KB pages).
const APPLE_SILICON = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               13171.
Pages active:                            234473.
Pages inactive:                          231329.
Pages speculative:                         1604.
Pages throttled:                              0.
Pages wired down:                        147613.
Pages purgeable:                           5236.
"Translation faults":                 412312874.
Pages copy-on-write:                   10985384.
Pages zero filled:                    197553542.
Pages reactivated:                      9076478.
Pages purged:                           2580128.
File-backed pages:                       181402.
Anonymous pages:                         286004.
Pages stored in compressor:              539862.
Pages occupied by compressor:            162540.
Decompressions:                         9934620.
Compressions:                          15620412.
Pageins:                                6315637.
Pageouts:                                 85203.
Swapins:                                 362720.
Swapouts:                                664520.
`;

// `vm_stat` on an Intel Mac (4 KB pages).
const INTEL = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                                5502.
Pages active:                            803912.
Pages inactive:                          780188.
Pages speculative:                        19376.
Pages throttled:                              0.
Pages wired down:                        481205.
Pages purgeable:                          60829.
"Translation faults":                3209876543.
Pages copy-on-write:                   74587631.
Pages zero filled:                   1530921876.
Pages reactivated:                     23456789.
Pages purged:                           8765432.
File-backed pages:                       612458.
Anonymous pages:                         991018.
Pages stored in compressor:             1268432.
Pages occupied by compressor:            503201.
Decompressions:                        43210987.
Compressions:                          65432109.
Pageins:                               19876543.
Pageouts:                                234567.
Swapins:                                1234567.
Swapouts:                               2345678.
`;

const GB = 1024 ** 3;

describe("vm_stat", () => {
  it("reads the page size from the header and every count", () => {
    const parsed = parseVmStat(APPLE_SILICON);
    assert.equal(parsed?.pageSize, 16384);
    assert.equal(parsed?.pages.free, 13171);
    assert.equal(parsed?.pages.inactive, 231329);
    assert.equal(parsed?.pages.speculative, 1604);
    assert.equal(parsed?.pages["wired down"], 147613);
    assert.equal(parsed?.pages["occupied by compressor"], 162540);
    assert.equal(parsed?.pages["translation faults"], 412312874, "a quoted label");
  });

  it("counts free, inactive and speculative pages as available", () => {
    const memory = memoryFromVmStat(parseVmStat(APPLE_SILICON), 16 * GB);
    const available = (13171 + 231329 + 1604) * 16384;
    assert.equal(memory?.availableBytes, available);
    assert.equal(memory?.usedBytes, 16 * GB - available);
    // About 12.2 GB in use: not the 15.8 GB that total - free-pages said.
    assert.ok(memory!.usedBytes / GB > 12 && memory!.usedBytes / GB < 12.5);
  });

  it("uses each machine's own page size", () => {
    const parsed = parseVmStat(INTEL);
    assert.equal(parsed?.pageSize, 4096);
    const memory = memoryFromVmStat(parsed, 16 * GB);
    assert.equal(memory?.availableBytes, (5502 + 780188 + 19376) * 4096);
  });

  it("never reports more available than there is memory", () => {
    const memory = memoryFromVmStat({ pageSize: 4096, pages: { free: 10_000_000, inactive: 0 } }, 8 * GB);
    assert.equal(memory?.availableBytes, 8 * GB);
    assert.equal(memory?.usedBytes, 0);
  });

  it("gives up on output it can't read, so the caller falls back", () => {
    assert.equal(parseVmStat(""), null, "no header, no page size");
    assert.equal(parseVmStat(null), null);
    assert.equal(memoryFromVmStat(parseVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\n"), 8 * GB), null);
  });
});

describe("vm.swapusage", () => {
  it("reads total and used in any unit", () => {
    assert.deepEqual(parseSwapUsage("vm.swapusage: total = 2048.00M  used = 1080.25M  free = 967.75M  (encrypted)\n"), {
      swapTotalBytes: 2048 * 1024 ** 2,
      swapUsedBytes: Math.round(1080.25 * 1024 ** 2),
    });
    assert.deepEqual(parseSwapUsage("vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)"), {
      swapTotalBytes: 0,
      swapUsedBytes: 0,
    });
    assert.equal(parseSwapUsage("vm.swapusage: total = 1.50G  used = 512.00M  free = 1.00G")?.swapTotalBytes, 1.5 * GB);
    assert.equal(parseSwapUsage(""), null);
  });
});
