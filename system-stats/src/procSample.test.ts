import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCimSample, parseProcStat, parsePsSample, parsePsTime, treeOf, windowFigures } from "../procSample.mjs";

describe("process samples", () => {
  it("reads a Linux /proc stat line, comm with spaces and parens included", () => {
    const raw = "4242 (my (odd) proc) S 100 4242 4242 0 -1 4194304 500 0 0 0 250 50 0 0 20 0 1 0 12345 104857600 2560 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";
    const info = parseProcStat(raw, 100, 4096);
    assert.deepEqual(info, { ppid: 100, cpuTimeMs: 3000, rssBytes: 2560 * 4096 });
  });

  it("reads ps times in every format", () => {
    assert.equal(parsePsTime("0:01.50"), 1500);
    assert.equal(parsePsTime("1:02:03.00"), 3_723_000);
    assert.equal(parsePsTime("2-01:00:00"), (49 * 3600) * 1000);
    assert.ok(Number.isNaN(parsePsTime("bogus")));
  });

  it("reads macOS ps output", () => {
    const map = parsePsSample("  1     0   0:10.00  4096\n 200     1   0:00.50   512\nnoise\n");
    assert.deepEqual(map.get(200), { ppid: 1, cpuTimeMs: 500, rssBytes: 512 * 1024 });
    assert.equal(map.size, 2);
  });

  it("reads the Windows CIM list, as an array or a single object", () => {
    const one = parseCimSample('{"ProcessId":8,"ParentProcessId":4,"KernelModeTime":10000000,"UserModeTime":20000000,"WorkingSetSize":1048576}');
    assert.deepEqual(one.get(8), { ppid: 4, cpuTimeMs: 3000, rssBytes: 1048576 });
    const many = parseCimSample('[{"ProcessId":1,"ParentProcessId":0},{"ProcessId":2,"ParentProcessId":1}]');
    assert.equal(many.size, 2);
    assert.equal(parseCimSample("not json").size, 0);
  });
});

describe("per-window figures", () => {
  const sample = (entries: Array<[number, number, number, number]>) =>
    new Map(entries.map(([pid, ppid, cpuTimeMs, rssBytes]) => [pid, { ppid, cpuTimeMs, rssBytes }]));

  it("walks a shell's whole tree and nothing else", () => {
    const s = sample([[10, 1, 0, 0], [11, 10, 0, 0], [12, 11, 0, 0], [20, 1, 0, 0]]);
    assert.deepEqual(treeOf(10, s).sort(), [10, 11, 12]);
  });

  it("sums CPU deltas and memory, with 100% as one core", () => {
    const before = sample([[10, 1, 1000, 100], [11, 10, 5000, 200]]);
    const after = sample([[10, 1, 1000, 100], [11, 10, 8000, 200], [12, 10, 1000, 50]]);
    // 3000ms from the running child, 1000ms from a new one, over 2s.
    assert.deepEqual(windowFigures(10, after, before, 2000), { cpuPercent: 200, rssBytes: 350 });
  });

  it("has no rate before a second sample", () => {
    const s = sample([[10, 1, 1000, 100]]);
    assert.deepEqual(windowFigures(10, s, undefined, 0), { cpuPercent: null, rssBytes: 100 });
  });
});
