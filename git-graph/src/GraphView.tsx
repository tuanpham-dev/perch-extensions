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
import { layoutGraph, maxLanes, WIP_COLOR, type GraphCommit, type GraphRow } from "./graphModel";
import { fileRows, type FileView, type TreeRow } from "./fileTree";
import { AuthorFilterMenu, BranchFilterMenu, FindBar, type AuthorEntry, type RefList } from "./FilterBar";
import {
  filterQuery,
  graphIsTruthful,
  loadFilter,
  matchIndexes,
  matchesQuery,
  saveFilter,
  type GraphFilter,
} from "./filterModel";
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
  readDateStyle,
  readFileView,
  readFirstParent,
  readPageSize,
  readPollInterval,
  readShowHash,
  readShowRemotes,
  readShowStashes,
  readShowTags,
  readShowUncommitted,
  shortHash,
  useSettingsRevision,
  writeFileView,
  type MenuItem,
} from "./client";

const ROW_HEIGHT = 26;
// Each lane is this wide in the graph column.
const LANE_WIDTH = 14;
const DOT_RADIUS = 3.5;
// Must match .gg-file's height and .gg-files' padding in style.css: these
// are what let the virtualizer size an expanded row without measuring it.
const FILE_ROW_HEIGHT = 22;
const FILES_PADDING = 6;
// Each tree level indents a file row by this much.
const TREE_INDENT = 12;

// The Uncommitted Changes row's key: the same pseudo-hash the server's
// /diff-sides takes for a working-tree diff. Not hex, so no real commit can
// ever share it.
const WORKING = "WORKING";

interface UncommittedSummary {
  head: string | null;
  count: number;
  digest: string;
}

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
  // Settings are read during render rather than captured once: the host
  // applies a change live, and this revision is what makes it land here.
  const settingsRevision = useSettingsRevision();
  const pageSize = useMemo(() => readPageSize(), [settingsRevision]);
  const firstParent = useMemo(() => readFirstParent(), [settingsRevision]);
  const dateStyle = useMemo(() => readDateStyle(), [settingsRevision]);
  const showHashSetting = useMemo(() => readShowHash(), [settingsRevision]);
  const showUncommitted = useMemo(() => readShowUncommitted(), [settingsRevision]);
  const fileView: FileView = useMemo(() => readFileView(), [settingsRevision]);

  const [commits, setCommits] = useState<Commit[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(() => readPageSize());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notRepo, setNotRepo] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, CommitFile[]>>({});
  // Folders collapsed in an expanded commit's tree, keyed by commit then by
  // folder path. Per commit, so collapsing "src" in one doesn't collapse it
  // in the next one you open.
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, string[]>>({});
  const [uncommitted, setUncommitted] = useState<UncommittedSummary | null>(null);
  const uncommittedDigest = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const refsHash = useRef<string | null>(null);

  // What this repository is showing. Seeded from the settings the first time
  // its graph is opened, its own after that - see filterModel.
  const [filter, setFilter] = useState<GraphFilter>(() =>
    loadFilter(root, { showRemotes: readShowRemotes(), showTags: readShowTags(), showStashes: readShowStashes() }),
  );
  useEffect(() => {
    setFilter(loadFilter(root, { showRemotes: readShowRemotes(), showTags: readShowTags(), showStashes: readShowStashes() }));
  }, [root]);
  useEffect(() => {
    saveFilter(root, filter);
  }, [root, filter]);

  // The two menus' listings, fetched when a menu is opened rather than with
  // the graph: most sessions never open them, and a repository with a few
  // thousand refs shouldn't pay for a list nobody asked to see.
  const [refList, setRefList] = useState<RefList | null>(null);
  const [refListState, setRefListState] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null,
  });
  const [authors, setAuthors] = useState<AuthorEntry[] | null>(null);
  const [authorsState, setAuthorsState] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null,
  });

  // The find bar. `filterMode` is the checkbox in it: highlight the matches
  // where they sit, or show nothing else.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filterMode, setFilterMode] = useState(false);
  const [matchAt, setMatchAt] = useState(0);

  // Deliberately does NOT clear the error line: every mutating action
  // reloads when it finishes, and a reload that cleared the error would
  // wipe the message the action just failed with before it could be read.
  // Whoever wants a clean slate (the first load, the Reload button, the
  // start of an action) clears it themselves.
  const load = useCallback(
    async (nextLimit: number) => {
      setLoading(true);
      try {
        const params = filterQuery(filter, new URLSearchParams({ cwd: root, limit: String(nextLimit) }));
        if (firstParent) params.set("firstParent", "1");
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
    [root, filter, firstParent],
  );

  // Every input `load` closes over - the repository, the filter, the
  // first-parent setting - starts the list again from page one, which is
  // what changing any of them means.
  useEffect(() => {
    setError(null);
    setFiles({});
    setExpanded(null);
    void load(pageSize);
  }, [load, pageSize]);

  // The Uncommitted Changes row's count. Only the summary - the file list
  // is fetched when the row is expanded, like any commit's. A changed digest
  // (files edited, staged, or HEAD moved) drops the cached file list so an
  // open expansion re-reads it.
  const loadUncommitted = useCallback(async () => {
    if (!showUncommitted) {
      uncommittedDigest.current = null;
      setUncommitted(null);
      return;
    }
    try {
      const data = await apiGetJson<UncommittedSummary>(`/uncommitted?cwd=${encodeURIComponent(root)}&summary=1`);
      if (uncommittedDigest.current === data.digest) return;
      uncommittedDigest.current = data.digest;
      setUncommitted(data);
      setFiles((cur) => {
        if (!(WORKING in cur)) return cur;
        const { [WORKING]: _dropped, ...rest } = cur;
        return rest;
      });
    } catch {
      // Decoration: a failed read just leaves the row as it was.
    }
  }, [root, showUncommitted]);

  useEffect(() => {
    void loadUncommitted();
  }, [loadUncommitted, commits]);

  const loadRefList = useCallback(async () => {
    setRefListState({ loading: true, error: null });
    try {
      const data = await apiGetJson<RefList>(`/refs?cwd=${encodeURIComponent(root)}`);
      setRefList(data);
      setRefListState({ loading: false, error: null });
    } catch (err) {
      setRefListState({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, [root]);

  // Over the refs the branch filter is showing, not the whole repository:
  // narrowing to one branch should offer that branch's authors. The author
  // choice itself is left out, or the list would shrink to whoever is
  // already picked.
  const loadAuthors = useCallback(async () => {
    setAuthorsState({ loading: true, error: null });
    try {
      const params = filterQuery({ ...filter, authors: [] }, new URLSearchParams({ cwd: root }));
      const data = await apiGetJson<{ authors: AuthorEntry[] }>(`/authors?${params}`);
      setAuthors(data.authors);
      setAuthorsState({ loading: false, error: null });
    } catch (err) {
      setAuthorsState({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, [root, filter]);

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
      // Editing a file moves no ref, so the working tree is checked on its
      // own - one `git status`, and nothing more unless it changed.
      if (!cancelled) void loadUncommitted();
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
  }, [active, notRepo, root, limit, load, loadUncommitted]);

  // ---- What the rows are, and whether the lanes can be drawn ----
  //
  // The lane drawing assumes every commit's parents are in the list. Two
  // things break that: an author filter (the server drops commits from the
  // middle of the DAG) and the find bar's Filter toggle (this does). Both
  // hide the graph column instead of drawing lines to commits that aren't
  // there, and show the short hash in its place so a row still has an
  // identity to copy.
  const searching = findOpen && query.trim() !== "";
  const hiding = searching && filterMode;
  const visible = useMemo(
    () => (hiding ? commits.filter((commit) => matchesQuery(commit, query)) : commits),
    [commits, hiding, query],
  );
  const graphOn = graphIsTruthful(filter) && !hiding;
  const showHash = showHashSetting || !graphOn;

  // The Uncommitted Changes row, drawn above HEAD like VS Code's Git Graph
  // does. Only while the lanes are drawn - it is a row joined to HEAD, and
  // means nothing in a filtered list - and only when HEAD is actually among
  // the loaded rows: with the branch filter narrowed to other branches there
  // is no HEAD row to join it to.
  const wipHead = uncommitted?.head ?? null;
  const showWip =
    graphOn &&
    uncommitted !== null &&
    uncommitted.count > 0 &&
    wipHead !== null &&
    commits.some((commit) => commit.hash === wipHead);
  const display = useMemo<Commit[]>(() => {
    if (!showWip || !uncommitted || !wipHead) return visible;
    const count = uncommitted.count;
    const wip: Commit = {
      hash: WORKING,
      parents: [wipHead],
      author: "",
      timestamp: 0,
      subject: `Uncommitted Changes (${count})`,
      refs: [],
    };
    return [wip, ...visible];
  }, [showWip, uncommitted, wipHead, visible]);

  const rows = useMemo(() => {
    if (!graphOn) return [];
    const input: GraphCommit[] = showWip && wipHead ? [{ hash: WORKING, parents: [wipHead], color: WIP_COLOR }, ...commits] : commits;
    return layoutGraph(input);
  }, [commits, graphOn, showWip, wipHead]);
  const laneCount = useMemo(() => maxLanes(rows), [rows]);
  const graphWidth = graphOn ? (laneCount + 1) * LANE_WIDTH : 0;

  // Positions in `display` that the find bar is stepping through. The
  // Uncommitted Changes row is never a hit: "changes" would match it.
  const hits = useMemo(
    () => (searching ? matchIndexes(display, query).filter((i) => display[i].hash !== WORKING) : []),
    [display, query, searching],
  );
  const currentHit = hits.length > 0 ? hits[Math.min(matchAt, hits.length - 1)] : -1;

  // An expanded commit's rows in the current view, or null while its file
  // list is still loading.
  const fileRowsFor = (hash: string): TreeRow<CommitFile>[] | null => {
    const list = files[hash];
    if (!list) return null;
    return fileRows(list, fileView, new Set(collapsedDirs[hash] ?? []));
  };

  const toggleDir = (hash: string, dir: string) => {
    setCollapsedDirs((cur) => {
      const set = new Set(cur[hash] ?? []);
      if (set.has(dir)) set.delete(dir);
      else set.add(dir);
      return { ...cur, [hash]: [...set] };
    });
  };

  // One virtual item per commit row, plus its file list when expanded. The
  // sizes are computed rather than measured: a row is exactly ROW_HEIGHT,
  // and an expanded one is that plus a fixed height per file. Handing the
  // virtualizer exact numbers avoids measureElement, which would force a
  // layout read for every rendered row on every scroll - the difference
  // between a smooth graph and a visibly stuttering one on a few thousand
  // commits.
  const virtualizer = useVirtualizer({
    count: display.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const hash = display[i]?.hash;
      if (hash && hash === expanded) {
        const list = fileRowsFor(hash);
        const count = list ? Math.max(list.length, 1) : 1;
        return ROW_HEIGHT + count * FILE_ROW_HEIGHT + FILES_PADDING;
      }
      return ROW_HEIGHT;
    },
    overscan: 8,
  });

  // Re-measure only when an expansion changes a row's height, not on scroll.
  useEffect(() => {
    virtualizer.measure();
  }, [expanded, files, collapsedDirs, fileView, display.length, virtualizer]);

  // ---- Find ----

  const step = useCallback(
    (delta: number) => {
      if (hits.length === 0) return;
      const next = (((matchAt + delta) % hits.length) + hits.length) % hits.length;
      setMatchAt(next);
      virtualizer.scrollToIndex(hits[next], { align: "center" });
    },
    [hits, matchAt, virtualizer],
  );

  // A new query starts from the top. Deliberately keyed on the query and not
  // on `hits`: a poll reload rebuilds the hit list, and scrolling on that
  // would yank the view out from under someone reading it.
  useEffect(() => {
    if (!searching) return;
    setMatchAt(0);
    const first = matchIndexes(display, query).find((i) => display[i].hash !== WORKING);
    if (first !== undefined) virtualizer.scrollToIndex(first, { align: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filterMode, searching]);

  // Ctrl+F / Cmd+F, but only when the keystroke belongs to this tab: with a
  // terminal split beside the graph, the terminal's own find should keep it.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "f") return;
      const focused = document.activeElement;
      const mine = focused === document.body || (focused !== null && viewRef.current?.contains(focused));
      if (!mine) return;
      e.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setQuery("");
    setFilterMode(false);
    setMatchAt(0);
  }, []);

  const toggleExpand = (commit: Commit) => {
    setExpanded((cur) => (cur === commit.hash ? null : commit.hash));
  };

  // Fills in the expanded row's file list whenever it is missing: on first
  // expansion, and again for the Uncommitted Changes row each time the
  // working tree changes under it (loadUncommitted drops the stale list).
  useEffect(() => {
    if (!expanded || files[expanded]) return;
    let cancelled = false;
    const url =
      expanded === WORKING
        ? `/uncommitted?cwd=${encodeURIComponent(root)}`
        : `/commit-files?cwd=${encodeURIComponent(root)}&hash=${expanded}`;
    apiGetJson<{ files: CommitFile[] }>(url)
      .then((data) => {
        if (!cancelled) setFiles((cur) => ({ ...cur, [expanded]: data.files }));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, files, root]);

  const openFile = async (commit: Commit, file: CommitFile) => {
    if (!openDiffInEditor) return;
    const params = new URLSearchParams({ cwd: root, hash: commit.hash, path: file.path });
    if (file.oldPath) params.set("oldPath", file.oldPath);
    try {
      const sides = await apiGetJson<{
        original: { content: string; label: string };
        modified: { content: string; label: string; path?: string; readOnlyReason?: string };
      }>(`/diff-sides?${params}`);
      await openDiffInEditor({
        title: `${basenameOf(file.path)} (${commit.hash === WORKING ? "Working Tree" : shortHash(commit.hash)})`,
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

  // Only Reload goes up into the tab bar, beside the other tabs' actions. The
  // filters, the count and Find live in the graph's own toolbar row below:
  // the tab strip is shared with every open tab and has no room for two
  // labelled menus, least of all on a phone.
  const tabActions = (
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
  );

  const toolbar = (
    <div className="gg-toolbar">
      <button
        className={`icon-button gg-toolbar-button${findOpen ? " active" : ""}`}
        title="Find a commit (Ctrl+F)"
        aria-pressed={findOpen}
        onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
      >
        <Icon name="search" />
      </button>
      <BranchFilterMenu
        filter={filter}
        refs={refList}
        loading={refListState.loading}
        error={refListState.error}
        onOpen={() => void loadRefList()}
        onChange={setFilter}
      />
      <AuthorFilterMenu
        filter={filter}
        authors={authors}
        loading={authorsState.loading}
        error={authorsState.error}
        onOpen={() => void loadAuthors()}
        onChange={setFilter}
      />
      <span className="gg-toolbar-spacer" />
      <span className="gg-count" title={`${visible.length} of ${total || visible.length} commits loaded`}>
        {visible.length} of {total || visible.length}
      </span>
      {/* Same icons and wording as SOURCE CONTROL's own toggle. It writes the
          setting itself, so the choice follows you to every graph tab. */}
      <button
        className="icon-button gg-toolbar-button"
        title={fileView === "tree" ? "View Changes as List" : "View Changes as Tree"}
        onClick={() => writeFileView(fileView === "tree" ? "list" : "tree")}
      >
        <Icon name={fileView === "tree" ? "list-flat" : "list-tree"} />
      </button>
    </div>
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
    <div className="gg-view" ref={viewRef}>
      {active && toolbarTarget && createPortal(tabActions, toolbarTarget)}
      {toolbar}
      {findOpen && (
        <FindBar
          query={query}
          onQuery={setQuery}
          matchCount={hits.length}
          position={hits.length === 0 ? 0 : Math.min(matchAt, hits.length - 1) + 1}
          onStep={step}
          filterMode={filterMode}
          onFilterMode={setFilterMode}
          onClose={closeFind}
        />
      )}
      {error && (
        <div className="gg-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <div className="gg-scroll" ref={scrollRef}>
        {visible.length === 0 ? (
          <div className="gg-empty">
            {loading
              ? "Loading…"
              : hiding
                ? "No commit matches."
                : filter.refs.length > 0 || filter.authors.length > 0
                  ? "No commits match this filter."
                  : "No commits yet."}
          </div>
        ) : (
          <div className="gg-rows" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const commit = display[item.index];
              const isWip = commit.hash === WORKING;
              const row = graphOn ? rows[item.index] : undefined;
              const isExpanded = expanded === commit.hash;
              const treeRows = isExpanded ? fileRowsFor(commit.hash) : null;
              const isMatch = searching && !isWip && matchesQuery(commit, query);
              return (
                <div
                  key={commit.hash}
                  className="gg-item"
                  style={{ transform: `translateY(${item.start}px)` }}
                  data-index={item.index}
                >
                  <div
                    className={`gg-row${isWip ? " wip" : ""}${isExpanded ? " expanded" : ""}${
                      isMatch ? " match" : ""
                    }${item.index === currentHit ? " current-match" : ""}`}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={() => toggleExpand(commit)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleExpand(commit);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      // The working tree is not a commit: none of checkout,
                      // branch, cherry-pick or reset apply to it.
                      if (!isWip) showMenu?.(e.clientX, e.clientY, commitMenu(commit));
                    }}
                  >
                    {graphOn && <LaneCell row={row} width={graphWidth} />}
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
                    <span
                      className="gg-time"
                      title={
                        isWip
                          ? undefined
                          : dateStyle === "absolute"
                            ? formatRelativeTime(commit.timestamp)
                            : formatAbsoluteTime(commit.timestamp)
                      }
                    >
                      {isWip
                        ? ""
                        : dateStyle === "absolute"
                          ? formatAbsoluteTime(commit.timestamp)
                          : formatRelativeTime(commit.timestamp)}
                    </span>
                    {/* Last, the way VS Code's Git Graph lays out its Commit
                        column. The working tree has no hash; "*" is what that
                        extension shows in its place. */}
                    {showHash && (
                      <span className="gg-hash" title={isWip ? "Not committed yet" : commit.hash}>
                        {isWip ? "*" : shortHash(commit.hash)}
                      </span>
                    )}
                  </div>
                  {isExpanded && (
                    <div className="gg-files" style={{ paddingLeft: graphWidth + 8 }}>
                      {graphOn && row && <LanesBelow lanes={row.below} width={graphWidth} />}
                      {!treeRows ? (
                        <div className="gg-file-empty">Loading…</div>
                      ) : treeRows.length === 0 ? (
                        <div className="gg-file-empty">
                          {isWip ? "No uncommitted changes." : "This commit changes no files."}
                        </div>
                      ) : (
                        treeRows.map((entry) =>
                          entry.kind === "dir" ? (
                            <div
                              key={`dir:${entry.path}`}
                              className="gg-file gg-dir"
                              role="button"
                              tabIndex={0}
                              aria-expanded={!entry.collapsed}
                              title={entry.path}
                              style={{ paddingLeft: entry.depth * TREE_INDENT }}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleDir(commit.hash, entry.path);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  toggleDir(commit.hash, entry.path);
                                }
                              }}
                            >
                              <Icon
                                name={entry.collapsed ? "chevron-right" : "chevron-down"}
                                className="gg-dir-chevron"
                              />
                              <span className="gg-file-path">{entry.name}</span>
                              {entry.collapsed && <span className="gg-dir-count">{entry.fileCount}</span>}
                            </div>
                          ) : (
                            <div
                              key={entry.file.path}
                              className="gg-file"
                              role="button"
                              tabIndex={0}
                              title={
                                entry.file.oldPath ? `${entry.file.oldPath} → ${entry.file.path}` : entry.file.path
                              }
                              style={{ paddingLeft: entry.depth * TREE_INDENT }}
                              onClick={(e) => {
                                e.stopPropagation();
                                void openFile(commit, entry.file);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void openFile(commit, entry.file);
                                }
                              }}
                            >
                              <span className={`gg-status s-${statusClass(entry.file.status)}`}>
                                {entry.file.status}
                              </span>
                              <span className="gg-file-path">{entry.name}</span>
                              <span className="gg-file-stat">
                                {entry.file.binary ? (
                                  <span className="gg-binary">binary</span>
                                ) : entry.file.status === "U" ? (
                                  <span className="gg-binary">untracked</span>
                                ) : (
                                  <>
                                    <span className="gg-added">+{entry.file.added}</span>{" "}
                                    <span className="gg-removed">-{entry.file.removed}</span>
                                  </>
                                )}
                              </span>
                            </div>
                          ),
                        )
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {commits.length > 0 && commits.length >= limit && (
          <button className="gg-more" disabled={loading} onClick={() => void load(limit + pageSize)}>
            {loading ? "Loading…" : "Load More"}
          </button>
        )}
      </div>
    </div>
  );
}

// A status letter's CSS class. "!" (an unresolved merge in the working
// tree) isn't a valid class-name character.
function statusClass(status: string): string {
  return status === "!" ? "conflict" : status;
}

// The graph column beside an expanded commit's file list: every lane that
// leaves the commit's row through its bottom edge, carried straight down to
// the next row so the lines stay joined across the list.
function LanesBelow({ lanes, width }: { lanes: GraphRow["below"]; width: number }) {
  if (lanes.length === 0) return null;
  const x = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
  return (
    <svg className="gg-lanes-below" width={width} aria-hidden="true">
      {lanes.map((l) => (
        <line key={l.lane} x1={x(l.lane)} y1="0" x2={x(l.lane)} y2="100%" className={`gg-edge c${l.color}`} />
      ))}
    </svg>
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
