// `git blame --porcelain`, turned into lines and runs.
//
// The porcelain format repeats a commit's metadata only the FIRST time that
// commit appears; later lines from the same commit carry the hash alone. So
// the parser has to remember what it has seen:
//
//   <sha> <origLine> <finalLine> [<groupSize>]
//   author QA Bot            <- only on that sha's first appearance
//   author-time 1789671160
//   summary Add alpha
//   filename alpha.txt
//   \t<the line's text>       <- always, tab-prefixed
//
// The all-zero sha is git's marker for a line that is not committed yet.
// Runs group consecutive lines from one commit so the gutter prints once per
// run instead of once per line.

export interface BlameLine {
  hash: string;
  author: string;
  timestamp: number;
  summary: string;
  // 1-based line number in the blamed revision.
  lineNo: number;
  content: string;
  uncommitted: boolean;
}

export interface BlameRun {
  hash: string;
  // Indexes into `lines`, inclusive.
  start: number;
  end: number;
}

export interface Blame {
  lines: BlameLine[];
  runs: BlameRun[];
}

const UNCOMMITTED = /^0{40}$/;

interface CommitMeta {
  author: string;
  timestamp: number;
  summary: string;
}

export function parseBlamePorcelain(text: string): Blame {
  const meta = new Map<string, CommitMeta>();
  const lines: BlameLine[] = [];

  let hash = "";
  let lineNo = 0;
  let pending: Partial<CommitMeta> = {};

  for (const raw of text.split("\n")) {
    if (raw.startsWith("\t")) {
      // The content line closes the current entry.
      if (!hash) continue;
      const known = meta.get(hash);
      const resolved: CommitMeta = {
        author: pending.author ?? known?.author ?? "",
        timestamp: pending.timestamp ?? known?.timestamp ?? 0,
        summary: pending.summary ?? known?.summary ?? "",
      };
      meta.set(hash, resolved);
      lines.push({
        hash,
        author: resolved.author,
        timestamp: resolved.timestamp,
        summary: resolved.summary,
        lineNo,
        content: raw.slice(1),
        uncommitted: UNCOMMITTED.test(hash),
      });
      pending = {};
      hash = "";
      continue;
    }

    const headerMatch = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(raw);
    if (headerMatch) {
      hash = headerMatch[1];
      lineNo = Number(headerMatch[2]);
      pending = {};
      continue;
    }

    if (raw.startsWith("author ")) pending.author = raw.slice("author ".length);
    else if (raw.startsWith("author-time ")) pending.timestamp = Number(raw.slice("author-time ".length));
    else if (raw.startsWith("summary ")) pending.summary = raw.slice("summary ".length);
    // Every other header (committer, filename, previous, boundary) is
    // deliberately ignored: nothing in the gutter renders from it.
  }

  const runs: BlameRun[] = [];
  for (let i = 0; i < lines.length; i++) {
    const last = runs[runs.length - 1];
    if (last && lines[i].hash === last.hash) last.end = i;
    else runs.push({ hash: lines[i].hash, start: i, end: i });
  }

  return { lines, runs };
}
