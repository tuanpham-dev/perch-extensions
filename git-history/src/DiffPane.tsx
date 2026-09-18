// A unified diff, rendered. Small on purpose: this extension has no editor
// and doesn't want one, but the History tab needs to show a commit's change
// to the file beside the list, which is the whole point of picking a commit.
//
// Handing the diff to the configured editor is still one click away in the
// pane's header; that path opens a real editor with both revisions.
import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "./Icon";
import { apiGetJson, basenameOf, shortHash } from "./client";
import { TokenLine, langFor, useTokens } from "./Highlight";

interface Props {
  root: string;
  // The path the file had AT that commit, which is what git can resolve.
  path: string;
  oldPath?: string | null;
  hash: string;
  subject: string;
  onOpenInEditor: () => void;
}

type LineKind = "add" | "del" | "ctx" | "meta";

interface DiffLine {
  kind: LineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

// "@@ -12,7 +12,9 @@" -> where each side's numbering restarts. A missing
// count means 1, which is git's own convention for a one-line hunk.
function parseHunkHeader(header: string): { oldStart: number; newStart: number } {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  return { oldStart: m ? Number(m[1]) : 1, newStart: m ? Number(m[2]) : 1 };
}

export function parseDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("@@")) {
      const { oldStart, newStart } = parseHunkHeader(raw);
      oldLine = oldStart;
      newLine = newStart;
      inHunk = true;
      out.push({ kind: "meta", text: raw, oldLine: null, newLine: null });
      continue;
    }
    if (!inHunk) {
      // "diff --git", "index abc..def", "--- a/x", "+++ b/x", "similarity
      // index" — kept, because a rename or a mode change says something the
      // hunks don't.
      if (raw.length > 0) out.push({ kind: "meta", text: raw, oldLine: null, newLine: null });
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), oldLine: null, newLine: newLine++ });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), oldLine: oldLine++, newLine: null });
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
      out.push({ kind: "meta", text: raw, oldLine: null, newLine: null });
    } else {
      out.push({ kind: "ctx", text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }
  // git ends the patch with a newline, which becomes a trailing empty
  // context line that would render as a stray blank row.
  while (out.length > 0 && out[out.length - 1].kind === "ctx" && out[out.length - 1].text === "") out.pop();
  return out;
}

export default function DiffPane({ root, path, oldPath, hash, subject, onOpenInEditor }: Props) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDiff(null);
    try {
      const params = new URLSearchParams({ cwd: root, path, hash });
      if (oldPath && oldPath !== path) params.set("oldPath", oldPath);
      const data = await apiGetJson<{ diff: string }>(`/file-diff?${params}`);
      setDiff(data.diff);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [root, path, oldPath, hash]);

  useEffect(() => {
    void load();
  }, [load]);

  const lines = useMemo(() => (diff ? parseDiff(diff) : []), [diff]);

  // Highlighting runs over the patch's code lines as one document in the
  // file's own language, not over the patch as "diff": the +/- column is
  // drawn separately, so what is left is source. Removed and added lines
  // sit next to each other, which can nudge a multi-line construct's
  // grammar state - the trade for colouring a patch at all without both
  // full revisions.
  const lang = useMemo(() => langFor(path), [path]);
  const codeLines = useMemo(() => lines.filter((l) => l.kind !== "meta"), [lines]);
  const code = useMemo(() => codeLines.map((l) => l.text).join("\n"), [codeLines]);
  const tokens = useTokens(code, lang);
  // Token rows are indexed over the code lines only, so meta rows have to be
  // skipped when looking one up.
  const codeIndexOf = useMemo(() => {
    const map = new Map<number, number>();
    let i = 0;
    lines.forEach((line, index) => {
      if (line.kind !== "meta") map.set(index, i++);
    });
    return map;
  }, [lines]);

  return (
    <div className="gh-diff">
      <div className="gh-diff-head">
        <span className="gh-diff-hash">{shortHash(hash)}</span>
        <span className="gh-diff-subject" title={`${subject}\n${path}`}>
          {subject}
        </span>
        <button className="icon-button" title="Open in Editor" onClick={onOpenInEditor}>
          <Icon name="link-external" />
        </button>
      </div>
      {error ? (
        <div className="gh-error">{error}</div>
      ) : loading ? (
        <div className="gh-empty">Loading…</div>
      ) : lines.length === 0 ? (
        <div className="gh-empty">This commit leaves {basenameOf(path)} unchanged.</div>
      ) : (
        <div className="gh-diff-body">
          {lines.map((line, i) => {
            const row = codeIndexOf.get(i);
            const lineTokens = row === undefined ? null : (tokens?.[row] ?? null);
            return (
              <div className={`gh-diff-line ${line.kind}`} key={i}>
                <span className="gh-diff-no">{line.oldLine ?? ""}</span>
                <span className="gh-diff-no">{line.newLine ?? ""}</span>
                <span className="gh-diff-sign">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                </span>
                <pre className="gh-diff-text">
                  {lineTokens ? <TokenLine tokens={lineTokens} /> : line.text || " "}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
