// The pure half of the gutter's change marks (gitGutter.ts), testable without
// Monaco: the line diff, and what the peek's Revert and Stage change compute.
//
// The line diff says which lines of the buffer differ from the file's base,
// re-run as the user types.
//
// Myers' O(ND) algorithm, over lines interned to numbers so each comparison
// is an integer test, after trimming the common head and tail — an edit
// session touches a few places in a long file, and the trim leaves only the
// stretch between the first and last change for the real work. The edit
// distance is capped: a file rewritten end to end would cost a quadratic
// trace for marks that cover everything anyway, so past the cap there are
// none.

/** A changed stretch: lines [aStart, aEnd) of the base became [bStart, bEnd)
 *  of the buffer. 0-based, end exclusive; an empty side is a pure insertion
 *  or deletion at that position. */
export interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

export type HunkKind = "added" | "modified" | "deleted";

export const DEFAULT_MAX_EDITS = 2000;

/** Lines the way Monaco counts them: a trailing newline leaves a last, empty
 *  line, so line i here is model line i + 1. Any line ending splits, so a
 *  CRLF buffer and an LF base compare by content. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

export function kindOf(h: Hunk): HunkKind {
  if (h.aStart === h.aEnd) return "added";
  if (h.bStart === h.bEnd) return "deleted";
  return "modified";
}

/** The hunks turning `a` into `b`, in order, or null when more than
 *  `maxEdits` inserted plus deleted lines separate them. */
export function diffLines(a: string[], b: string[], maxEdits = DEFAULT_MAX_EDITS): Hunk[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) {
    return n + m > maxEdits ? null : [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }];
  }

  const ids = new Map<string, number>();
  const intern = (line: string) => {
    let id = ids.get(line);
    if (id === undefined) ids.set(line, (id = ids.size));
    return id;
  };
  const A = new Int32Array(n);
  const B = new Int32Array(m);
  for (let i = 0; i < n; i++) A[i] = intern(a[start + i]);
  for (let j = 0; j < m; j++) B[j] = intern(b[start + j]);

  const max = Math.min(n + m, maxEdits);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // snaps[d] holds v[k] for k in [-d, d] after round d, at index k + d.
  const snaps: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    snaps.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) return null;

  // Walk the trace back from (n, m), marking the deleted base lines and the
  // inserted buffer lines; what's unmarked on each side pairs up in order.
  const deleted = new Uint8Array(n);
  const inserted = new Uint8Array(m);
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = snaps[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    if (down) inserted[prevY] = 1;
    else deleted[prevX] = 1;
    x = prevX;
    y = prevY;
  }

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if ((i < n && deleted[i]) || (j < m && inserted[j])) {
      const h = { aStart: start + i, aEnd: 0, bStart: start + j, bEnd: 0 };
      // Until the next unchanged line, however the deletes and inserts
      // interleave: no kept line between them means one change.
      while ((i < n && deleted[i]) || (j < m && inserted[j])) {
        if (i < n && deleted[i]) i++;
        else j++;
      }
      h.aEnd = start + i;
      h.bEnd = start + j;
      hunks.push(h);
    } else {
      i++;
      j++;
    }
  }
  return hunks;
}

// ---- Revert and stage ----
//
// Lines come from splitLines on all three texts: the base (the file in HEAD),
// the staged version, and the buffer. Changes are hunks of base → buffer.

/** The line ending a text mostly uses, for joining lines back into it. */
export function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** The buffer with one change put back to the base's lines. */
export function revertedLines(base: string[], buffer: string[], h: Hunk): string[] {
  return [...buffer.slice(0, h.bStart), ...base.slice(h.aStart, h.aEnd), ...buffer.slice(h.bEnd)];
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

// Whether two stretches of the base collide. Abutting non-empty ranges
// don't, but an insertion touching the other range does: two insertions at
// one point, or one at an edge, have no order that is obviously right.
function overlaps(s: Hunk, h: Hunk): boolean {
  const lo = Math.max(s.aStart, h.aStart);
  const hi = Math.min(s.aEnd, h.aEnd);
  if (lo < hi) return true;
  return (s.aStart === s.aEnd || h.aStart === h.aEnd) && lo <= hi;
}

/** Whether the staged version already has this change exactly. */
export function isStaged(base: string[], staged: string[] | null, buffer: string[], h: Hunk): boolean {
  if (!staged) return false;
  const stagedHunks = diffLines(base, staged);
  if (!stagedHunks) return false;
  const want = buffer.slice(h.bStart, h.bEnd);
  return stagedHunks.some(
    (s) => s.aStart === h.aStart && s.aEnd === h.aEnd && sameLines(staged.slice(s.bStart, s.bEnd), want),
  );
}

/**
 * The staged version with this change added and everything else it already
 * had kept. The change is placed by its position in the base, shifted by
 * whatever the staged version inserts or removes above it. A change whose
 * lines the staged version has already changed some other way can't be
 * placed without guessing, so that is refused.
 */
export function stagedLinesFor(
  base: string[],
  staged: string[],
  buffer: string[],
  h: Hunk,
): { lines: string[] } | { error: string } {
  const stagedHunks = diffLines(base, staged);
  if (!stagedHunks) return { error: "The staged version is too different from the last commit to stage part of it." };
  let shift = 0;
  for (const s of stagedHunks) {
    if (overlaps(s, h)) {
      const same = s.aStart === h.aStart && s.aEnd === h.aEnd && sameLines(staged.slice(s.bStart, s.bEnd), buffer.slice(h.bStart, h.bEnd));
      return {
        error: same
          ? "This change is already staged."
          : "These lines are staged with different changes. Unstage the file in Source Control to stage this one.",
      };
    }
    if (s.aEnd <= h.aStart) shift += s.bEnd - s.bStart - (s.aEnd - s.aStart);
  }
  return {
    lines: [
      ...staged.slice(0, h.aStart + shift),
      ...buffer.slice(h.bStart, h.bEnd),
      ...staged.slice(h.aEnd + shift),
    ],
  };
}

/** A Monaco-style edit (1-based lines and columns) and its text. */
export interface LineEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

/**
 * The smallest whole-line edit turning `from` into `to`, so a revert is one
 * undo step over just the lines it changes and the cursor elsewhere stays
 * put. Lines are model lines (splitLines), so the last one has no ending:
 * an edit reaching it takes the ending before it instead of after.
 */
export function lineEdit(from: string[], to: string[], eol: string): LineEdit | null {
  let p = 0;
  while (p < from.length && p < to.length && from[p] === to[p]) p++;
  let q = 0;
  while (q < from.length - p && q < to.length - p && from[from.length - 1 - q] === to[to.length - 1 - q]) q++;
  const oldEnd = from.length - q;
  const mid = to.slice(p, to.length - q);
  if (p === oldEnd && mid.length === 0) return null;
  if (q > 0) {
    return { startLine: p + 1, startColumn: 1, endLine: oldEnd + 1, endColumn: 1, text: mid.map((l) => l + eol).join("") };
  }
  const last = from.length;
  const end = { endLine: last, endColumn: from[last - 1].length + 1 };
  if (p === 0) return { startLine: 1, startColumn: 1, ...end, text: mid.join(eol) };
  return { startLine: p, startColumn: from[p - 1].length + 1, ...end, text: mid.map((l) => eol + l).join("") };
}
