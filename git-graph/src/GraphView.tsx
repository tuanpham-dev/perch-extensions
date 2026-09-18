// The GRAPH tab: one row per commit, its lane drawn in SVG beside it, its
// ref labels as chips, and a menu on both the row and each chip.
//
// Rows are virtualized because a repository with a few thousand commits is
// ordinary. The graph column is drawn per row rather than as one tall SVG for
// the same reason: only the visible rows exist in the DOM.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import Icon from "./Icon";
import { copyText } from "./clipboard";
import { layoutGraph, maxLanes, type GraphRow } from "./graphModel";
import {
  ApiError,
  apiGetJson,
  apiPost,
  basenameOf,
  confirmDialog,
  formatAbsoluteTime,
  formatRelativeTime,
  openDiffInEditor,
  promptDialog,
  readPollInterval,
  readShowRemotes,
  shortHash,
  type MenuItem,
} from "./client";

const PAGE = 300;
const ROW_HEIGHT = 26;
// Each lane is this wide in the graph column.
const LANE_WIDTH = 14;
const DOT_RADIUS = 3.5;
// Must match .gg-file's height and .gg-files' padding in style.css: these
// are what let the virtualizer size an expanded row without measuring it.
const FILE_ROW_HEIGHT = 22;
const FILES_PADDING = 6;

export interface CommitRef {
  name: string;
  type: "branch" | "remote" | "tag" | "head" | "stash";
  current: boolean;
  remote?: string;
  branch?: string;
}

interface Commit {
  hash: string;
  parents: string[];
  author: string;
  timestamp: number;
  subject: string;
  refs: CommitRef[];
}

interface CommitFile {
  path: string;
  oldPath: string | null;
  status: string;
  added: number;
  removed: number;
  binary: boolean;
}

interface Props {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  reloadKey?: number;
}

export default function GraphView({ filePath: root, active, toolbarTarget, showMenu }: Props) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(PAGE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notRepo, setNotRepo] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, CommitFile[]>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const refsHash = useRef<string | null>(null);

  // Deliberately does NOT clear the error line: every mutating action
  // reloads when it finishes, and a reload that cleared the error would
  // wipe the message the action just failed with before it could be read.
  // Whoever wants a clean slate (the first load, the Reload button, the
  // start of an action) clears it themselves.
  const load = useCallback(
    async (nextLimit: number) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          cwd: root,
          limit: String(nextLimit),
          remotes: readShowRemotes() ? "1" : "0",
        });
        const data = await apiGetJson<{ commits: Commit[]; total: number; refsHash?: string }>(
          `/log?${params}`,
        );
        setCommits(data.commits);
        setTotal(data.total);
        setLimit(nextLimit);
        setNotRepo(false);
        // The ref state these rows were read at: a poll tick compares
        // against this, so a tab coming back into view notices a branch
        // that moved while it was hidden.
        if (data.refsHash) refsHash.current = data.refsHash;
      } catch (err) {
        if (err instanceof Error && /not a git repository/i.test(err.message)) setNotRepo(true);
        else setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [root],
  );

  useEffect(() => {
    setError(null);
    void load(PAGE);
  }, [load]);

  // Poll for ref movement only while this tab is the active one, and only
  // reload the (much heavier) log when the digest actually changed.
  useEffect(() => {
    if (!active || notRepo) return;
    let cancelled = false;
    const check = async () => {
      try {
        const data = await apiGetJson<{ hash: string }>(`/refs-hash?cwd=${encodeURIComponent(root)}`);
        if (cancelled) return;
        if (refsHash.current !== null && refsHash.current !== data.hash) {
          setFiles({});
          void load(limit);
        }
        refsHash.current = data.hash;
      } catch {
        // A transient failure just means the next tick tries again.
      }
    };
    // Once as soon as the tab becomes active - whatever moved while it was
    // hidden should be on screen immediately, not an interval later - and
    // then on the interval.
    void check();
    const timer = window.setInterval(check, readPollInterval());
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, notRepo, root, limit, load]);

  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const laneCount = useMemo(() => maxLanes(rows), [rows]);
  const graphWidth = (laneCount + 1) * LANE_WIDTH;

  // One virtual item per commit row, plus its file list when expanded. The
  // sizes are computed rather than measured: a row is exactly ROW_HEIGHT,
  // and an expanded one is that plus a fixed height per file. Handing the
  // virtualizer exact numbers avoids measureElement, which would force a
  // layout read for every rendered row on every scroll - the difference
  // between a smooth graph and a visibly stuttering one on a few thousand
  // commits.
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const hash = commits[i]?.hash;
      if (hash && hash === expanded) {
        const list = files[hash];
        const fileRows = list ? Math.max(list.length, 1) : 1;
        return ROW_HEIGHT + fileRows * FILE_ROW_HEIGHT + FILES_PADDING;
      }
      return ROW_HEIGHT;
    },
    overscan: 8,
  });

  // Re-measure only when an expansion changes a row's height, not on scroll.
  useEffect(() => {
    virtualizer.measure();
  }, [expanded, files, virtualizer]);

  const toggleExpand = async (commit: Commit) => {
    if (expanded === commit.hash) {
      setExpanded(null);
      return;
    }
    setExpanded(commit.hash);
    if (files[commit.hash]) return;
    try {
      const data = await apiGetJson<{ files: CommitFile[] }>(
        `/commit-files?cwd=${encodeURIComponent(root)}&hash=${commit.hash}`,
      );
      setFiles((cur) => ({ ...cur, [commit.hash]: data.files }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openFile = async (commit: Commit, file: CommitFile) => {
    if (!openDiffInEditor) return;
    const params = new URLSearchParams({ cwd: root, hash: commit.hash, path: file.path });
    if (file.oldPath) params.set("oldPath", file.oldPath);
    try {
      const sides = await apiGetJson<{
        original: { content: string; label: string };
        modified: { content: string; label: string; readOnlyReason?: string };
      }>(`/diff-sides?${params}`);
      await openDiffInEditor({
        title: `${basenameOf(file.path)} (${shortHash(commit.hash)})`,
        original: sides.original,
        modified: sides.modified,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Every mutating action lands here: report a conflict stop as guidance
  // rather than an error, then reload so the graph shows the new shape.
  const runOp = useCallback(
    async (fn: () => Promise<{ ok: boolean; conflicted?: boolean; operation?: string }>) => {
      setError(null);
      try {
        const result = await fn();
        if (result?.conflicted) {
          setError(
            `The ${result.operation ?? "operation"} stopped on a conflict - resolve it in SOURCE CONTROL.`,
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        refsHash.current = null;
        setFiles({});
        await load(limit);
      }
    },
    [limit, load],
  );

  const confirm = async (message: string, label: string): Promise<boolean> =>
    (await confirmDialog?.(message, label)) ?? false;

  const ask = async (message: string, defaultValue?: string): Promise<string | null> => {
    const answer = await promptDialog?.(message, defaultValue);
    const trimmed = answer?.trim();
    return trimmed ? trimmed : null;
  };

  // Reset targets the checked-out branch, so it is offered only when there
  // is one: on a detached HEAD there is nothing to move.
  const hasCurrentBranch = commits.some((c) => c.refs.some((r) => r.type === "branch" && r.current));

  const commitMenu = (commit: Commit): MenuItem[] => {
    const short = shortHash(commit.hash);
    const items: MenuItem[] = [
      { label: "Copy SHA", onClick: () => void copyText(commit.hash) },
      { label: "Copy Message", onClick: () => void copyText(commit.subject) },
      {
        label: "Checkout",
        onClick: async () => {
          if (!(await confirm(`Check out ${short} in detached HEAD state?`, "Checkout"))) return;
          await runOp(() => apiPost("/checkout", { cwd: root, hash: commit.hash })).catch(() => {});
        },
      },
      {
        label: "Create Branch Here…",
        onClick: async () => {
          const name = await ask(`New branch at ${short}`);
          if (!name) return;
          await runOp(() => apiPost("/branch-create", { cwd: root, name, hash: commit.hash, checkout: true })).catch(
            () => {},
          );
        },
      },
      {
        label: "Create Tag Here…",
        onClick: async () => {
          const name = await ask(`New tag at ${short}`);
          if (!name) return;
          const message = (await ask("Tag message (leave empty for a lightweight tag)")) ?? "";
          await runOp(() => apiPost("/tag-create", { cwd: root, name, hash: commit.hash, message })).catch(() => {});
        },
      },
      {
        label: "Cherry-pick",
        onClick: () => void runOp(() => apiPost("/cherry-pick", { cwd: root, hash: commit.hash })).catch(() => {}),
      },
      {
        label: "Revert",
        onClick: () => void runOp(() => apiPost("/revert", { cwd: root, hash: commit.hash })).catch(() => {}),
      },
    ];
    if (hasCurrentBranch) {
      const reset = (mode: "soft" | "mixed" | "hard", label: string, danger?: boolean): MenuItem => ({
        label: `Reset Current Branch to Here: ${label}`,
        danger,
        onClick: async () => {
          if (mode === "hard" && !(await confirm(`Reset to ${short}? Uncommitted changes are discarded.`, "Reset"))) {
            return;
          }
          await runOp(() => apiPost("/reset", { cwd: root, hash: commit.hash, mode })).catch(() => {});
        },
      });
      items.push(reset("soft", "Soft - keep the changes staged"));
      items.push(reset("mixed", "Mixed - keep the changes unstaged"));
      items.push(reset("hard", "Hard - discard the changes", true));
    }
    return items;
  };

  const refMenu = (ref: CommitRef): MenuItem[] => {
    if (ref.type === "tag") {
      return [
        { label: "Copy Name", onClick: () => void copyText(ref.name) },
        {
          label: "Delete Tag",
          danger: true,
          onClick: async () => {
            if (!(await confirm(`Delete tag ${ref.name}?`, "Delete"))) return;
            await runOp(() => apiPost("/tag-delete", { cwd: root, name: ref.name })).catch(() => {});
          },
        },
      ];
    }
    if (ref.type === "remote") {
      return [
        {
          label: "Checkout as Local Branch",
          onClick: () =>
            void runOp(() => apiPost("/checkout", { cwd: root, branch: ref.branch, track: ref.name })).catch(() => {}),
        },
        { label: "Copy Name", onClick: () => void copyText(ref.name) },
        {
          label: "Delete Remote Branch",
          danger: true,
          onClick: async () => {
            if (!(await confirm(`Delete ${ref.name} on the remote?`, "Delete"))) return;
            await runOp(() =>
              apiPost("/remote-branch-delete", { cwd: root, remote: ref.remote, branch: ref.branch }),
            ).catch(() => {});
          },
        },
      ];
    }
    if (ref.type === "branch") {
      const items: MenuItem[] = [];
      if (!ref.current) {
        items.push({
          label: "Switch to Branch",
          onClick: () => void runOp(() => apiPost("/checkout", { cwd: root, branch: ref.name })).catch(() => {}),
        });
      }
      items.push({ label: "Copy Name", onClick: () => void copyText(ref.name) });
      if (!ref.current) {
        items.push({
          label: "Delete Branch",
          danger: true,
          onClick: async () => {
            if (!(await confirm(`Delete branch ${ref.name}?`, "Delete"))) return;
            try {
              await runOp(() => apiPost("/branch-delete", { cwd: root, name: ref.name, force: false }));
            } catch (err) {
              if (err instanceof ApiError && err.unmerged) {
                if (!(await confirm(`Branch ${ref.name} is not fully merged. Delete anyway?`, "Delete Anyway"))) return;
                await runOp(() => apiPost("/branch-delete", { cwd: root, name: ref.name, force: true })).catch(
                  () => {},
                );
              }
            }
          },
        });
      }
      return items;
    }
    return [{ label: "Copy Name", onClick: () => void copyText(ref.name) }];
  };

  const toolbar = (
    <>
      <span className="gg-count">
        {commits.length} of {total || commits.length}
      </span>
      <button
        className="icon-button"
        title="Reload"
        onClick={() => {
          setError(null);
          void load(limit);
        }}
      >
        <Icon name="refresh" />
      </button>
    </>
  );

  if (notRepo) {
    return (
      <div className="gg-view">
        <div className="gg-empty">Not a git repository: {basenameOf(root)}</div>
      </div>
    );
  }

  const items = virtualizer.getVirtualItems();

  return (
    <div className="gg-view">
      {active && toolbarTarget && createPortal(toolbar, toolbarTarget)}
      {error && (
        <div className="gg-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <div className="gg-scroll" ref={scrollRef}>
        {commits.length === 0 ? (
          <div className="gg-empty">{loading ? "Loading…" : "No commits yet."}</div>
        ) : (
          <div className="gg-rows" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const commit = commits[item.index];
              const row = rows[item.index];
              const isExpanded = expanded === commit.hash;
              const list = files[commit.hash];
              return (
                <div
                  key={commit.hash}
                  className="gg-item"
                  style={{ transform: `translateY(${item.start}px)` }}
                  data-index={item.index}
                >
                  <div
                    className={`gg-row${isExpanded ? " expanded" : ""}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => void toggleExpand(commit)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void toggleExpand(commit);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      showMenu?.(e.clientX, e.clientY, commitMenu(commit));
                    }}
                  >
                    <LaneCell row={row} width={graphWidth} />
                    <span className="gg-refs">
                      {commit.refs.map((ref) => (
                        <span
                          key={`${ref.type}:${ref.name}`}
                          className={`gg-ref ${ref.type}${ref.current ? " current" : ""}`}
                          title={ref.type === "remote" ? `remote branch ${ref.name}` : ref.type}
                          onClick={(e) => {
                            e.stopPropagation();
                            showMenu?.(e.clientX, e.clientY, refMenu(ref));
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            showMenu?.(e.clientX, e.clientY, refMenu(ref));
                          }}
                        >
                          {ref.name}
                        </span>
                      ))}
                    </span>
                    <span className="gg-subject" title={commit.subject}>
                      {commit.subject}
                    </span>
                    <span className="gg-author">{commit.author}</span>
                    <span className="gg-time" title={formatAbsoluteTime(commit.timestamp)}>
                      {formatRelativeTime(commit.timestamp)}
                    </span>
                  </div>
                  {isExpanded && (
                    <div className="gg-files" style={{ paddingLeft: graphWidth + 8 }}>
                      {!list ? (
                        <div className="gg-file-empty">Loading…</div>
                      ) : list.length === 0 ? (
                        <div className="gg-file-empty">This commit changes no files.</div>
                      ) : (
                        list.map((file) => (
                          <div
                            key={file.path}
                            className="gg-file"
                            role="button"
                            tabIndex={0}
                            title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                            onClick={(e) => {
                              e.stopPropagation();
                              void openFile(commit, file);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                void openFile(commit, file);
                              }
                            }}
                          >
                            <span className={`gg-status s-${file.status}`}>{file.status}</span>
                            <span className="gg-file-path">{file.path}</span>
                            <span className="gg-file-stat">
                              {file.binary ? (
                                <span className="gg-binary">binary</span>
                              ) : (
                                <>
                                  <span className="gg-added">+{file.added}</span>{" "}
                                  <span className="gg-removed">-{file.removed}</span>
                                </>
                              )}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {commits.length > 0 && commits.length >= limit && (
          <button className="gg-more" disabled={loading} onClick={() => void load(limit + PAGE)}>
            {loading ? "Loading…" : "Load More"}
          </button>
        )}
      </div>
    </div>
  );
}

// One row's slice of the graph: the lanes passing behind it, the edges
// leaving it, and its own dot. Drawn per row so only visible rows cost
// anything.
function LaneCell({ row, width }: { row: GraphRow | undefined; width: number }) {
  if (!row) return <span className="gg-lane" style={{ width }} />;
  const x = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
  const mid = ROW_HEIGHT / 2;
  return (
    <svg
      className="gg-lane"
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      aria-hidden="true"
    >
      {row.through.map((t) => (
        <line
          key={`t${t.lane}`}
          x1={x(t.lane)}
          y1={0}
          x2={x(t.lane)}
          y2={ROW_HEIGHT}
          className={`gg-edge c${t.color}`}
        />
      ))}
      {row.edges.map((edge, i) => {
        if (edge.fromLane === edge.toLane) {
          // A lane continuing straight: down from the dot for a parent, or
          // in from above for a lane arriving at it.
          return (
            <line
              key={`e${i}`}
              x1={x(edge.fromLane)}
              y1={edge.kind === "branch" ? 0 : mid}
              x2={x(edge.toLane)}
              y2={edge.kind === "branch" ? mid : ROW_HEIGHT}
              className={`gg-edge c${edge.color}`}
            />
          );
        }
        // Three curves, by where the line starts and ends on this row:
        //   branch    from another lane above, into this dot
        //   converge  straight through from above into another lane below
        //   merge     from this dot, out to a parent's lane below
        const from = x(edge.fromLane);
        const to = x(edge.toLane);
        const d =
          edge.kind === "branch"
            ? `M ${from} 0 C ${from} ${mid}, ${to} ${mid}, ${to} ${mid}`
            : edge.kind === "converge"
              ? `M ${from} 0 C ${from} ${mid}, ${to} ${mid}, ${to} ${ROW_HEIGHT}`
              : `M ${from} ${mid} C ${from} ${ROW_HEIGHT}, ${to} ${mid}, ${to} ${ROW_HEIGHT}`;
        return <path key={`e${i}`} d={d} className={`gg-edge c${edge.color}`} fill="none" />;
      })}
      <circle cx={x(row.lane)} cy={mid} r={DOT_RADIUS} className={`gg-dot c${row.color}`} />
    </svg>
  );
}
