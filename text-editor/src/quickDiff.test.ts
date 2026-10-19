// The gutter's pure half: the line diff the marks are drawn from, and the
// texts Revert and Stage change produce. Randomized round trips back the
// handful of named cases, since an off-by-one in a diff shows up as a mark
// on the wrong line rather than as a crash.
import { strict as assert } from "node:assert";
import { test } from "node:test";

const { diffLines, splitLines, kindOf, revertedLines, isStaged, stagedLinesFor, lineEdit, eolOf } = await import(
  "./quickDiff.ts"
);

type Hunk = { aStart: number; aEnd: number; bStart: number; bEnd: number };

// Rebuilds b from a and the hunks, which must be in order and never touch.
function apply(a: string[], b: string[], hunks: Hunk[]): string[] {
  const out: string[] = [];
  let i = 0;
  let prevEnd = -1;
  for (const h of hunks) {
    assert.ok(h.aStart > prevEnd || prevEnd === -1, "hunks are separated by an unchanged line");
    out.push(...a.slice(i, h.aStart), ...b.slice(h.bStart, h.bEnd));
    i = h.aEnd;
    prevEnd = h.aEnd;
  }
  out.push(...a.slice(i));
  return out;
}

const L = (s: string) => splitLines(s);

test("equal texts have no hunks", () => {
  assert.deepEqual(diffLines(L("a\nb\n"), L("a\nb\n")), []);
});

test("a CRLF buffer equals its LF base", () => {
  assert.deepEqual(diffLines(L("a\nb\n"), L("a\r\nb\r\n")), []);
});

test("insert, delete and replace are told apart", () => {
  const base = L("one\ntwo\nthree\nfour\n");
  const hunks = diffLines(base, L("one\nTWO\nthree\nfour\nfive\n"))!;
  assert.deepEqual(hunks, [
    { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
    { aStart: 4, aEnd: 4, bStart: 4, bEnd: 5 },
  ]);
  assert.deepEqual(hunks.map(kindOf), ["modified", "added"]);
  const del = diffLines(base, L("one\nfour\n"))!;
  assert.deepEqual(del, [{ aStart: 1, aEnd: 3, bStart: 1, bEnd: 1 }]);
  assert.equal(kindOf(del[0]), "deleted");
});

test("changes at the very start and end", () => {
  assert.deepEqual(diffLines(L("a\nb"), L("x\na\nb")), [{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 }]);
  assert.deepEqual(diffLines(L("a\nb"), L("a\nc")), [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
  assert.deepEqual(diffLines(L("a\nb\n"), L("a\nb")), [{ aStart: 2, aEnd: 3, bStart: 2, bEnd: 2 }]);
});

test("past the edit cap there is no answer", () => {
  const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
  assert.equal(diffLines(a, b, 20), null);
  assert.ok(diffLines(a, b, 100));
});

function randomLines(rand: () => number, n: number): string[] {
  return Array.from({ length: n }, () => "abcde"[Math.floor(rand() * 5)]);
}

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("random diffs rebuild their target and are minimal in size", () => {
  const rand = mulberry(7);
  for (let round = 0; round < 500; round++) {
    const a = randomLines(rand, Math.floor(rand() * 12));
    const b = randomLines(rand, Math.floor(rand() * 12));
    const hunks = diffLines(a, b)!;
    assert.deepEqual(apply(a, b, hunks), b, `${a.join("")} -> ${b.join("")}`);
    // Edit count = |a| + |b| - 2·LCS.
    const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    const edits = hunks.reduce((n: number, h: Hunk) => n + (h.aEnd - h.aStart) + (h.bEnd - h.bStart), 0);
    assert.equal(edits, a.length + b.length - 2 * lcs[0][0]);
  }
});

test("revert puts one change back and leaves the others", () => {
  const base = L("one\ntwo\nthree\nfour\n");
  const buffer = L("one\nTWO\nthree\nfour\nfive\n");
  const [modified, added] = diffLines(base, buffer)!;
  assert.deepEqual(revertedLines(base, buffer, modified), L("one\ntwo\nthree\nfour\nfive\n"));
  assert.deepEqual(revertedLines(base, buffer, added), L("one\nTWO\nthree\nfour\n"));
});

// Applies a LineEdit to the text the lines came from.
function applyEdit(lines: string[], eol: string, e: { startLine: number; startColumn: number; endLine: number; endColumn: number; text: string }) {
  const text = lines.join(eol);
  const offset = (line: number, col: number) =>
    lines.slice(0, line - 1).reduce((n, l) => n + l.length + eol.length, 0) + col - 1;
  return text.slice(0, offset(e.startLine, e.startColumn)) + e.text + text.slice(offset(e.endLine, e.endColumn));
}

test("lineEdit reproduces the target text, ends of file included", () => {
  const rand = mulberry(11);
  for (const eol of ["\n", "\r\n"]) {
    for (let round = 0; round < 500; round++) {
      // At least one line: a model always has one.
      const from = randomLines(rand, 1 + Math.floor(rand() * 6));
      const to = randomLines(rand, 1 + Math.floor(rand() * 6));
      if (rand() < 0.3) from[from.length - 1] = "";
      if (rand() < 0.3) to[to.length - 1] = "";
      const e = lineEdit(from, to, eol);
      const got = e ? applyEdit(from, eol, e) : from.join(eol);
      assert.equal(got, to.join(eol), `${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
    }
  }
});

test("staging lands the change in a staged version that differs elsewhere", () => {
  const base = L("a\nb\nc\nd\ne\n");
  // Staged already: an extra line at the top.
  const staged = L("top\na\nb\nc\nd\ne\n");
  // Buffer: top line unstaged-but-present, and d changed.
  const buffer = L("top\na\nb\nc\nD\ne\n");
  const hunks = diffLines(base, buffer)!;
  const dChange = hunks.find((h: Hunk) => base[h.aStart] === "d")!;
  const result = stagedLinesFor(base, staged, buffer, dChange);
  assert.ok("lines" in result);
  assert.deepEqual(result.lines, L("top\na\nb\nc\nD\ne\n"));
  assert.equal(isStaged(base, staged, buffer, dChange), false);
  assert.equal(isStaged(base, staged, buffer, hunks[0]), true);
});

test("staging a deletion at the end and an insertion at the start", () => {
  const base = L("a\nb\nc");
  const buffer = L("x\na\nb");
  const [ins, del] = diffLines(base, buffer)!;
  const r1 = stagedLinesFor(base, base, buffer, del);
  assert.ok("lines" in r1);
  assert.deepEqual(r1.lines, L("a\nb"));
  const r2 = stagedLinesFor(base, r1.lines, buffer, ins);
  assert.ok("lines" in r2);
  assert.deepEqual(r2.lines, buffer);
});

test("lines staged with a different change are refused, the same change is already staged", () => {
  const base = L("a\nb\nc\n");
  const buffer = L("a\nB\nc\n");
  const [h] = diffLines(base, buffer)!;
  const other = stagedLinesFor(base, L("a\nbee\nc\n"), buffer, h);
  assert.ok("error" in other && /different changes/.test(other.error));
  const same = stagedLinesFor(base, buffer, buffer, h);
  assert.ok("error" in same && /already staged/.test(same.error));
  assert.equal(isStaged(base, buffer, buffer, h), true);
  assert.equal(isStaged(base, null, buffer, h), false);
});

test("a CRLF staged version keeps its line endings", () => {
  const stagedText = "a\r\nb\r\n";
  const base = L(stagedText);
  const buffer = L("a\nB\n");
  const [h] = diffLines(base, buffer)!;
  const r = stagedLinesFor(base, L(stagedText), buffer, h);
  assert.ok("lines" in r);
  assert.equal(r.lines.join(eolOf(stagedText)), "a\r\nB\r\n");
});
