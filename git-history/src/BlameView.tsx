// Who last touched each line, at HEAD or at a pinned revision.
//
// Rendered as blocks, not as a list of lines. A real file's blame is a few
// long runs, not many short ones: 2,600 lines of one source file came out as
// 25 runs, so a per-line gutter would be blank for 99% of rows and nothing
// would say where one commit's territory ended. So each run is one block
// with its own shading, its own age stripe, and a gutter that sticks to the
// top of the viewport while you scroll through it - you can always see whose
// block you are in.
//
// The code is syntax-highlighted through the same lazily-loaded Shiki chunk
// claude-viewer uses, following the active Perch theme. Blame's content is
// the whole file in order, so the highlighting is exact.
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import { parseBlamePorcelain, type Blame } from "./blameModel";
import { TokenLine, langFor, useTokens } from "./Highlight";
import {
  apiGetJson,
  decodeKey,
  formatAbsoluteTime,
  formatRelativeTime,
  openCommitFileDiff,
  shortHash,
} from "./client";

interface BlameResponse {
  porcelain: string;
  rev?: string | null;
  path?: string;
  tooLarge?: boolean;
  binary?: boolean;
}

interface Props {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  reloadKey?: number;
}

// How many steps the age stripe has. Newest commits get the warmest step,
// the oldest the coolest - the same "heat" idea every blame UI uses, so a
// glance tells you which parts of the file are recent work.
const AGE_STEPS = 6;

export default function BlameView({ filePath, active, toolbarTarget, reloadKey }: Props) {
  const { root, relPath, rev } = decodeKey(filePath);
  const [blame, setBlame] = useState<Blame | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "too-large" | "binary" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  // The commit the pointer is over: every block of that same commit lights
  // up, which is how you see a commit's whole footprint in a file.
  const [hoveredHash, setHoveredHash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const params = new URLSearchParams({ cwd: root, path: relPath });
      if (rev) params.set("rev", rev);
      const data = await apiGetJson<BlameResponse>(`/blame?${params}`);
      if (data.tooLarge) {
        setState("too-large");
        return;
      }
      if (data.binary) {
        setState("binary");
        return;
      }
      setBlame(parseBlamePorcelain(data.porcelain));
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, [root, relPath, rev]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // Age buckets are relative to this file's own history: in a file whose
  // commits all landed last week, the oldest still reads as "old here".
  const ageOf = useMemo(() => {
    const times = (blame?.lines ?? []).filter((l) => !l.uncommitted).map((l) => l.timestamp);
    if (times.length === 0) return () => 0;
    const min = Math.min(...times);
    const max = Math.max(...times);
    if (max === min) return () => AGE_STEPS - 1;
    return (timestamp: number) => {
      const t = (timestamp - min) / (max - min);
      return Math.min(AGE_STEPS - 1, Math.floor(t * AGE_STEPS));
    };
  }, [blame]);

  // Blame's content IS the whole file, in order, so highlighting it is
  // exact rather than the approximation a patch forces.
  const lang = useMemo(() => langFor(relPath), [relPath]);
  const code = useMemo(() => (blame?.lines ?? []).map((l) => l.content).join("\n"), [blame]);
  const tokens = useTokens(code, lang);

  const toolbar = (
    <button className="icon-button" title="Reload" onClick={() => void load()}>
      <Icon name="refresh" />
    </button>
  );

  const body = () => {
    if (state === "error") return <div className="gh-error">{error}</div>;
    if (state === "too-large") return <div className="gh-empty">Too large to blame.</div>;
    if (state === "binary") return <div className="gh-empty">Binary file.</div>;
    if (state === "loading" || !blame) return <div className="gh-empty">Loading…</div>;
    if (blame.lines.length === 0) return <div className="gh-empty">This file is empty.</div>;

    return (
      <div className="gh-blame">
        {blame.runs.map((run, runIndex) => {
          const first = blame.lines[run.start];
          const lineCount = run.end - run.start + 1;
          const hovered = hoveredHash === first.hash && !first.uncommitted;
          const classes = [
            "gh-run",
            runIndex % 2 === 1 ? "alt" : "",
            first.uncommitted ? "uncommitted" : "",
            hovered ? "hovered" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={`${run.hash}-${run.start}`}
              className={classes}
              onMouseEnter={() => setHoveredHash(first.uncommitted ? null : first.hash)}
              onMouseLeave={() => setHoveredHash(null)}
            >
              <span className={`gh-age a${first.uncommitted ? "-wip" : ageOf(first.timestamp)}`} aria-hidden="true" />
              {first.uncommitted ? (
                <div className="gh-gutter">
                  <span className="gh-gutter-top">
                    <span className="gh-gutter-wip">Not committed</span>
                  </span>
                  <span className="gh-gutter-count">{lineCount > 1 ? `${lineCount} lines` : "1 line"}</span>
                </div>
              ) : (
                <button
                  className="gh-gutter"
                  title={`${first.summary}\n${first.author} · ${formatAbsoluteTime(first.timestamp)}\nClick to open this commit's diff of the file`}
                  onClick={() => void openCommitFileDiff(root, relPath, first.hash)}
                >
                  <span className="gh-gutter-top">
                    <span className="gh-gutter-hash">{shortHash(first.hash)}</span>
                    <span className="gh-gutter-age">{formatRelativeTime(first.timestamp)}</span>
                  </span>
                  {/* The message, not just the author: "why is this line
                      here" is the question a blame is opened to answer. */}
                  <span className="gh-gutter-summary">{first.summary}</span>
                  <span className="gh-gutter-bottom">
                    <span className="gh-gutter-author">{first.author}</span>
                    <span className="gh-gutter-count">{lineCount > 1 ? `${lineCount} lines` : "1 line"}</span>
                  </span>
                </button>
              )}
              <div className="gh-run-lines">
                {blame.lines.slice(run.start, run.end + 1).map((line, offset) => {
                  const lineTokens = tokens?.[run.start + offset] ?? null;
                  return (
                    <div className="gh-line" key={line.lineNo}>
                      <span className="gh-lineno">{line.lineNo}</span>
                      <pre className="gh-code">
                        {lineTokens ? <TokenLine tokens={lineTokens} /> : line.content || " "}
                      </pre>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="gh-view">
      {active && toolbarTarget && createPortal(toolbar, toolbarTarget)}
      <div className="gh-head">
        <span className="gh-path">{relPath}</span>
        <span className="gh-rev">{rev ? `@ ${shortHash(rev)}` : "@ HEAD"}</span>
        {blame && state === "ready" && (
          <span className="gh-summary-count">
            {blame.runs.length} {blame.runs.length === 1 ? "block" : "blocks"} · {blame.lines.length} lines
          </span>
        )}
      </div>
      {body()}
    </div>
  );
}
