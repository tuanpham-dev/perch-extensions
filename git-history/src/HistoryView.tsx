// One file's commits, newest first, following it through renames. A row
// opens that file's diff at that commit; its menu can pin the Blame view to
// that revision. Read-only.
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import DiffPane from "./DiffPane";
import { useSplit } from "./useSplit";
import { copyText } from "./clipboard";
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
  const { root, relPath } = decodeKey(filePath);
  const [commits, setCommits] = useState<HistoryCommit[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The commit whose change to this file fills the right column.
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [wide, setWide] = useState(() => window.matchMedia(TWO_COLUMN_MIN).matches);
  const split = useSplit("gitHistory.splitWidth");

  useEffect(() => {
    const mq = window.matchMedia(TWO_COLUMN_MIN);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const load = useCallback(
    async (nextLimit: number) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ cwd: root, path: relPath, limit: String(nextLimit) });
        const data = await apiGetJson<{ commits: HistoryCommit[] }>(`/history?${params}`);
        setCommits(data.commits);
        setLimit(nextLimit);
        // Open on the newest commit rather than an empty right column: "what
        // changed here last" is the question the tab is opened with.
        setSelectedHash((cur) =>
          cur && data.commits.some((c) => c.hash === cur) ? cur : (data.commits[0]?.hash ?? null),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [root, relPath],
  );

  useEffect(() => {
    void load(PAGE);
  }, [load, reloadKey]);

  const selectCommit = (commit: HistoryCommit) => {
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
    <button className="icon-button" title="Reload" onClick={() => void load(limit)}>
      <Icon name="refresh" />
    </button>
  );

  const selected = commits.find((c) => c.hash === selectedHash) ?? null;

  const list = (
    <div className="gh-list">
      {commits.map((commit) => (
        <div
          key={commit.hash}
          className={`gh-row${wide && commit.hash === selectedHash ? " selected" : ""}`}
          role="button"
          tabIndex={0}
          title={`${commit.subject}\n${commit.author} · ${formatAbsoluteTime(commit.timestamp)}${
            commit.oldPath ? `\nrenamed from ${commit.oldPath}` : ""
          }`}
          onClick={() => selectCommit(commit)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
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
      {commits.length >= limit && (
        <button className="gh-more" disabled={loading} onClick={() => void load(limit + PAGE)}>
          {loading ? "Loading…" : "Load More"}
        </button>
      )}
    </div>
  );

  return (
    <div className={`gh-view${wide ? " two-column" : ""}`}>
      {active && toolbarTarget && createPortal(toolbar, toolbarTarget)}
      <div className="gh-head">
        <span className="gh-path">{relPath}</span>
        {commits.length > 0 && (
          <span className="gh-summary-count">
            {commits.length} {commits.length === 1 ? "commit" : "commits"}
          </span>
        )}
      </div>
      {error ? (
        <div className="gh-error">{error}</div>
      ) : commits.length === 0 ? (
        <div className="gh-empty">{loading ? "Loading…" : "No commits touch this file."}</div>
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
