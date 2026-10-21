// One file's commits, newest first, following it through renames - or, for
// a tab opened from a Blame selection, the commits that changed one range of
// its lines. A row opens that file's diff at that commit; its menu can pin
// the Blame view to that revision. The list pages in 50 at a time, filters
// as you type, and walks with the arrow keys (Enter opens the diff in the
// editor). Read-only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import DiffPane from "./DiffPane";
import { useSplit } from "./useSplit";
import { copyText } from "./clipboard";
import { matchesFilter } from "./historyModel";
import {
  apiGetJson,
  basenameOf,
  decodeKey,
  encodeKey,
  formatAbsoluteTime,
  formatRelativeTime,
  openCommitFileDiff,
  openViewerTab,
  shortHash,
  type MenuItem,
} from "./client";

const PAGE = 50;
// The server's ceiling for one call; Reload re-reads a long list in pieces.
const MAX_PER_CALL = 500;

// Below this the tab is too narrow for a list and a diff side by side, so it
// becomes one column and a row opens the diff in the configured editor, as
// it always did.
const TWO_COLUMN_MIN = "(min-width: 900px)";

interface HistoryCommit {
  hash: string;
  author: string;
  timestamp: number;
  subject: string;
  status: string;
  // The path the file had at that commit, and the name before a rename.
  path: string;
  oldPath: string | null;
}

interface Props {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  reloadKey?: number;
}

export default function HistoryView({ filePath, active, toolbarTarget, showMenu, reloadKey }: Props) {
  const { root, relPath, rev, lines } = decodeKey(filePath);
  const [commits, setCommits] = useState<HistoryCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // The commit whose change to this file fills the right column.
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  // The keyboard's row in the one-column layout, where selecting a row
  // would open an editor; in two columns it is the selection itself.
  const [cursorHash, setCursorHash] = useState<string | null>(null);
  const [wide, setWide] = useState(() => window.matchMedia(TWO_COLUMN_MIN).matches);
  const split = useSplit("gitHistory.splitWidth");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia(TWO_COLUMN_MIN);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const fetchPage = useCallback(
    async (skip: number, limit: number) => {
      const params = new URLSearchParams({ cwd: root, path: relPath, limit: String(limit), skip: String(skip) });
      if (lines) params.set("lines", lines);
      if (lines && rev) params.set("rev", rev);
      return apiGetJson<{ commits: HistoryCommit[]; hasMore?: boolean }>(`/history?${params}`);
    },
    [root, relPath, rev, lines],
  );

  // Reads the first `count` commits again (Reload, or the first open), in
  // pieces the server accepts, so a list paged far down keeps its length.
  const load = useCallback(
    async (count: number) => {
      setLoading(true);
      setError(null);
      try {
        const all: HistoryCommit[] = [];
        let more = true;
        while (more && all.length < count) {
          const asked = Math.min(MAX_PER_CALL, count - all.length);
          const data = await fetchPage(all.length, asked);
          all.push(...data.commits);
          more = data.hasMore ?? data.commits.length === asked;
        }
        setCommits(all);
        setHasMore(more);
        // Open on the newest commit rather than an empty right column: "what
        // changed here last" is the question the tab is opened with.
        setSelectedHash((cur) => (cur && all.some((c) => c.hash === cur) ? cur : (all[0]?.hash ?? null)));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [fetchPage],
  );

  // The next page, after the commits already listed.
  const loadMore = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPage(commits.length, PAGE);
      setCommits((cur) => {
        const seen = new Set(cur.map((c) => c.hash));
        return [...cur, ...data.commits.filter((c) => !seen.has(c.hash))];
      });
      setHasMore(data.hasMore ?? data.commits.length === PAGE);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(PAGE);
  }, [load, reloadKey]);

  const shown = useMemo(() => commits.filter((c) => matchesFilter(c, filter)), [commits, filter]);
  const keyboardHash = wide ? selectedHash : cursorHash;

  // Arrow keys move through the filtered rows, from the list or the filter
  // box; Enter opens the row's diff in the editor.
  const onListKey = (e: React.KeyboardEvent, fromFilter = false) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = shown.findIndex((c) => c.hash === keyboardHash);
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(shown.length - 1, at + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, at - 1);
    else if (e.key === "PageDown") next = Math.min(shown.length - 1, Math.max(0, at) + 10);
    else if (e.key === "PageUp") next = Math.max(0, at - 10);
    else if (!fromFilter && e.key === "Home") next = 0;
    else if (!fromFilter && e.key === "End") next = shown.length - 1;
    else if (e.key === "Enter") {
      const commit = shown[at] ?? (fromFilter ? shown[0] : undefined);
      if (!commit) return;
      e.preventDefault();
      void openCommitFileDiff(root, commit.path, commit.hash, commit.oldPath);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    const commit = shown[next];
    if (!commit) return;
    if (wide) setSelectedHash(commit.hash);
    else setCursorHash(commit.hash);
    const row = listRef.current?.querySelector<HTMLElement>(`[data-hash="${commit.hash}"]`);
    if (fromFilter) row?.scrollIntoView({ block: "nearest" });
    else row?.focus();
  };

  const selectCommit = (commit: HistoryCommit) => {
    setCursorHash(commit.hash);
    if (wide) {
      setSelectedHash(commit.hash);
      return;
    }
    void openCommitFileDiff(root, commit.path, commit.hash, commit.oldPath);
  };

  const menuFor = (commit: HistoryCommit): MenuItem[] => [
    {
      label: "Open Diff",
      onClick: () => void openCommitFileDiff(root, commit.path, commit.hash, commit.oldPath),
    },
    {
      label: "View at This Revision",
      onClick: () =>
        openViewerTab?.("blame", encodeKey(root, commit.path, commit.hash), {
          title: `Blame · ${basenameOf(commit.path)} @ ${shortHash(commit.hash)}`,
        }),
    },
    { label: "Copy SHA", onClick: () => void copyText(commit.hash) },
  ];

  const toolbar = (
    <button className="icon-button" title="Reload" onClick={() => void load(Math.max(PAGE, commits.length))}>
      <Icon name="refresh" />
    </button>
  );

  const selected = commits.find((c) => c.hash === selectedHash) ?? null;

  const list = (
    <div className="gh-list" ref={listRef} role="listbox" aria-label="Commits" onKeyDown={(e) => onListKey(e)}>
      {shown.map((commit) => (
        <div
          key={commit.hash}
          data-hash={commit.hash}
          className={`gh-row${wide && commit.hash === selectedHash ? " selected" : ""}${!wide && commit.hash === cursorHash ? " cursor" : ""}`}
          role="option"
          aria-selected={commit.hash === keyboardHash}
          tabIndex={commit.hash === keyboardHash || (!keyboardHash && commit === shown[0]) ? 0 : -1}
          title={`${commit.subject}\n${commit.author} · ${formatAbsoluteTime(commit.timestamp)}${
            commit.oldPath ? `\nrenamed from ${commit.oldPath}` : ""
          }`}
          onClick={() => selectCommit(commit)}
          onKeyDown={(e) => {
            if (e.key === " ") {
              e.preventDefault();
              selectCommit(commit);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            showMenu?.(e.clientX, e.clientY, menuFor(commit));
          }}
        >
          <span className="gh-hash">{shortHash(commit.hash)}</span>
          <span className="gh-subject">{commit.subject}</span>
          {commit.oldPath && (
            <span className="gh-renamed" title={`renamed from ${commit.oldPath}`}>
              renamed
            </span>
          )}
          <span className="gh-author">{commit.author}</span>
          <span className="gh-time">{formatRelativeTime(commit.timestamp)}</span>
        </div>
      ))}
      {filter && shown.length === 0 && <div className="gh-empty">No loaded commit matches.</div>}
      {hasMore && (
        <button className="gh-more" disabled={loading} onClick={() => void loadMore()}>
          {loading ? "Loading…" : filter ? "Load More (the filter only searches loaded commits)" : "Load More"}
        </button>
      )}
    </div>
  );

  return (
    <div className={`gh-view${wide ? " two-column" : ""}`}>
      {active && toolbarTarget && createPortal(toolbar, toolbarTarget)}
      <div className="gh-head">
        <span className="gh-path">{relPath}</span>
        {lines && <span className="gh-rev">lines {lines.replace(",", "–")}{rev ? ` @ ${shortHash(rev)}` : ""}</span>}
        {commits.length > 0 && (
          <input
            className="gh-filter"
            type="search"
            placeholder="Filter by message, author or SHA"
            aria-label="Filter commits"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              onListKey(e, true);
            }}
          />
        )}
        {commits.length > 0 && (
          <span className="gh-summary-count">
            {filter ? `${shown.length} of ` : ""}
            {commits.length}
            {hasMore ? "+" : ""} {commits.length === 1 ? "commit" : "commits"}
          </span>
        )}
      </div>
      {error ? (
        <div className="gh-error">{error}</div>
      ) : commits.length === 0 ? (
        <div className="gh-empty">{loading ? "Loading…" : lines ? "No commits touch these lines." : "No commits touch this file."}</div>
      ) : wide ? (
        <div
          className={`gh-split${split.dragging ? " dragging" : ""}`}
          ref={split.containerRef}
          style={{ gridTemplateColumns: `${split.width}px 1px 1fr` }}
        >
          <div className="gh-split-list">{list}</div>
          <div className="gh-split-handle" title="Drag to resize" {...split.handleProps} />
          <div className="gh-split-diff">
            {selected ? (
              <DiffPane
                key={selected.hash}
                root={root}
                path={selected.path}
                oldPath={selected.oldPath}
                hash={selected.hash}
                subject={selected.subject}
                onOpenInEditor={() =>
                  void openCommitFileDiff(root, selected.path, selected.hash, selected.oldPath)
                }
              />
            ) : (
              <div className="gh-empty">Select a commit to see its change.</div>
            )}
          </div>
        </div>
      ) : (
        list
      )}
    </div>
  );
}
