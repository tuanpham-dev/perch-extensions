// The AGENTS tab: every terminal window running a coding agent, as a card in
// a status column (or a project column), scoped to the project you came from,
// every project, or a set you pick. Opened through ctx.app.openViewerTab from
// the "Agent Board: Open" command - see client.tsx.
//
// The board polls server.js's /agents only while its tab is the active one,
// and keeps everything it remembers (scope, selection, grouping, the order
// you dragged cards into) in this browser - see boardModel.ts.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import BoardCard from "./BoardCard";
import {
  columnIdOf,
  columnsFor,
  inScope,
  loadBoardState,
  looksHookless,
  moveInOrder,
  projectsOf,
  pruneOrder,
  relativeTime,
  saveBoardState,
  type BoardAgent,
  type BoardState,
  type Column,
  type GroupBy,
  type Mark,
  type ScopeMode,
} from "./boardModel";
import { copyText, getJson, host, pollIntervalMs, SETTING_DEFAULT_SCOPE, type MenuItem } from "./host";

interface FileViewerHostProps {
  filePath: string;
  active: boolean;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
}

interface ProjectInfo {
  repo: string;
  project: string;
  branch: string | null;
  linked: boolean;
}

// ---- Drag ----
//
// Pointer events rather than HTML5 drag-and-drop, which never fires for a
// finger. A mouse drags a card from anywhere on it once the pointer has moved
// a few pixels, so a click is still a click.
//
// A finger drags only from the card's grip. Not a long press on the card:
// Chrome hands a finger that starts on a pannable element to the compositor,
// which cancels the pointer (pointercancel, and not one touchmove to call
// preventDefault on) the moment it moves - tested in this app on 2026-09-11.
// `touch-action: none` is the only thing that keeps the finger, and on the
// whole card it would make every column impossible to scroll. So the grip
// carries it, and a flick anywhere else scrolls as it always did. A long
// press on the rest of the card is the touch right-click: the card's menu.
const MOUSE_DRAG_PX = 4;
const TOUCH_DRAG_PX = 3;
const TOUCH_SLOP_PX = 8;
const LONG_PRESS_MS = 450;
const RETURN_MS = 180;

export type PressSource = "card" | "grip";

interface DragSession {
  paneId: string;
  columnId: string;
  pointerId: number;
  // "menu": a finger on the card body, which can only long-press.
  kind: "drag" | "menu";
  startX: number;
  startY: number;
  threshold: number;
  active: boolean;
  beforeId: string | null;
  refused: boolean;
  timer: number | null;
  cleanup: () => void;
}

interface DragView {
  paneId: string;
  columnId: string;
  dx: number;
  dy: number;
  beforeId: string | null;
  refused: boolean;
}

const EMPTY_COLUMN_TEXT: Record<string, string> = {
  working: "Nothing running",
  waiting: "Nobody needs you",
  done: "Nothing finished",
  idle: "Nothing idle",
};

function HeaderMark({ mark }: { mark: Mark }) {
  return (
    <span className={`agent-board-mark agent-monitor-badge-${mark}`} aria-hidden="true">
      {mark === "waiting" ? "?" : "●"}
    </span>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function BoardView({ active, showMenu }: FileViewerHostProps) {
  // ---- View state, remembered per browser ----
  const [state, setState] = useState<BoardState>(() => loadBoardState(host.settings?.get(SETTING_DEFAULT_SCOPE)));
  const stateRef = useRef(state);
  stateRef.current = state;
  const updateState = useCallback((patch: Partial<BoardState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      saveBoardState(next);
      return next;
    });
  }, []);

  // ---- Rows ----
  const [rows, setRows] = useState<BoardAgent[] | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const missesRef = useRef<Record<string, number>>({});

  const refresh = useCallback(async () => {
    try {
      const body = await getJson<{ agents?: BoardAgent[] }>("/agents");
      const list = body.agents ?? [];
      const at = Date.now();
      setRows(list);
      setUpdatedAt(at);
      setNow(at);
      setFailed(false);
      const pruned = pruneOrder(
        stateRef.current.order,
        list.map((row) => row.paneId),
        missesRef.current,
      );
      missesRef.current = pruned.misses;
      if (pruned.order.length !== stateRef.current.order.length) updateState({ order: pruned.order });
    } catch {
      // Keep the last cards; the toolbar says how old they are.
      setFailed(true);
      setNow(Date.now());
    }
  }, [updateState]);

  const [pollMs, setPollMs] = useState(pollIntervalMs);
  useEffect(() => host.settings?.onDidChange(() => setPollMs(pollIntervalMs())), []);

  // Only while the tab is the one on screen: a board in a background tab
  // makes no requests at all.
  useEffect(() => {
    if (!active) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(id);
  }, [active, pollMs, refresh]);

  // ---- "This project" ----
  //
  // The project of the tab you came from: while this tab is on screen the
  // host reports the last terminal's context (or the project this tab was
  // opened from), never "no context" - see perch's useTabs.ts. Resolved by
  // the server, since the active folder may have no agent in it to learn the
  // repository from.
  const [activeCwd, setActiveCwd] = useState<string | null>(() => host.app?.getActiveContext().cwd ?? null);
  useEffect(() => host.app?.onDidChangeContext((next) => setActiveCwd(next.cwd)), []);
  const [current, setCurrent] = useState<{ cwd: string; info: ProjectInfo | null } | null>(null);
  useEffect(() => {
    if (!activeCwd) {
      setCurrent(null);
      return;
    }
    let cancelled = false;
    getJson<ProjectInfo>(`/project?cwd=${encodeURIComponent(activeCwd)}`)
      .then((info) => {
        if (!cancelled) setCurrent({ cwd: activeCwd, info });
      })
      .catch(() => {
        if (!cancelled) setCurrent({ cwd: activeCwd, info: null });
      });
    return () => {
      cancelled = true;
    };
  }, [activeCwd]);
  const currentResolved = !activeCwd || current?.cwd === activeCwd;
  const currentInfo = currentResolved ? (current?.info ?? null) : null;
  const currentRepo = currentInfo?.repo || null;

  // ---- Derived ----
  const allRows = rows ?? [];
  const scopedRows = useMemo(
    () => allRows.filter((row) => inScope(row, { mode: state.scope, selected: state.selected, currentRepo })),
    [allRows, state.scope, state.selected, currentRepo],
  );
  const columns = useMemo(() => columnsFor(scopedRows, state.groupBy, state.order), [scopedRows, state.groupBy, state.order]);
  const columnsRef = useRef<Column[]>(columns);
  columnsRef.current = columns;
  const allProjects = useMemo(() => projectsOf(allRows), [allRows]);

  // ---- Actions ----
  const openTerminal = useCallback((row: BoardAgent) => {
    host.app?.openSessionWindow(row.sessionName, { windowIndex: row.windowIndex });
  }, []);

  const killSession = useCallback(
    async (row: BoardAgent) => {
      const ok = await host.app?.confirmDialog(
        `Kill session "${row.sessionName}"? Every window in it closes, not only this agent.`,
        "Kill Session",
      );
      if (!ok) return;
      host.app?.killSession(row.sessionName);
      window.setTimeout(() => void refresh(), 800);
    },
    [refresh],
  );

  const openMenu = useCallback(
    (row: BoardAgent, x: number, y: number) => {
      if (!showMenu) return;
      const items: MenuItem[] = [
        { label: "Open Terminal", icon: "terminal", onClick: () => openTerminal(row) },
        { label: "Copy Folder Path", icon: "copy", onClick: () => void copyText(row.cwd) },
      ];
      if (row.prompt) {
        const prompt = row.prompt;
        items.push({ label: "Copy Prompt", icon: "quote", onClick: () => void copyText(prompt) });
      }
      items.push({ label: "", separator: true, onClick: () => {} });
      items.push({ label: "Kill Session…", icon: "trash", danger: true, onClick: () => void killSession(row) });
      showMenu(x, y, items);
    },
    [showMenu, openTerminal, killSession],
  );

  // ---- Drag ----
  const boardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const [dragView, setDragView] = useState<DragView | null>(null);
  const [returningId, setReturningId] = useState<string | null>(null);
  const suppressClickRef = useRef(false);

  const dropTarget = (drag: DragSession, x: number, y: number): { beforeId: string | null; refused: boolean } => {
    const colEl = boardRef.current?.querySelector<HTMLElement>(`[data-column-id="${CSS.escape(drag.columnId)}"]`);
    if (!colEl) return { beforeId: null, refused: true };
    const rect = colEl.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return { beforeId: null, refused: true };
    const cards = [...colEl.querySelectorAll<HTMLElement>("[data-pane-id]")].filter((el) => el.dataset.paneId !== drag.paneId);
    for (const el of cards) {
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) return { beforeId: el.dataset.paneId ?? null, refused: false };
    }
    return { beforeId: null, refused: false };
  };

  const endDrag = (commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    drag.cleanup();
    setDragView(null);
    if (drag.active) {
      // The click that follows this pointerup belongs to the drag.
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      const column = columnsRef.current.find((col) => col.id === drag.columnId);
      if (commit && !drag.refused && column) {
        const ids = column.cards.map((card) => card.paneId);
        updateState({ order: moveInOrder(stateRef.current.order, ids, drag.paneId, drag.beforeId) });
      } else {
        setReturningId(drag.paneId);
        window.setTimeout(() => setReturningId((id) => (id === drag.paneId ? null : id)), RETURN_MS);
      }
    }
  };
  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;

  // The native contextmenu a long press fires on Android would open a second
  // menu on top of the one the long press below already opened.
  const lastPointerTypeRef = useRef<string>("mouse");

  const onCardPointerDown = (event: ReactPointerEvent<HTMLElement>, row: BoardAgent, source: PressSource) => {
    lastPointerTypeRef.current = event.pointerType;
    if (dragRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const touch = event.pointerType !== "mouse";
    const kind: DragSession["kind"] = touch && source === "card" ? "menu" : "drag";
    const el = event.currentTarget;
    if (kind === "drag" && touch) {
      // The grip: keep the finger from here, before any move can be claimed.
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        // Already gone.
      }
    }

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (drag.kind === "menu") {
        // Moved before the long press: a scroll, which the browser is
        // already doing.
        if (Math.hypot(dx, dy) > TOUCH_SLOP_PX) endDragRef.current(false);
        return;
      }
      if (!drag.active) {
        if (Math.hypot(dx, dy) < drag.threshold) return;
        drag.active = true;
        try {
          el.setPointerCapture(drag.pointerId);
        } catch {
          // The pointer is already gone; the next pointerup ends the drag.
        }
      }
      const target = dropTarget(drag, e.clientX, e.clientY);
      drag.beforeId = target.beforeId;
      drag.refused = target.refused;
      setDragView({ paneId: drag.paneId, columnId: drag.columnId, dx, dy, beforeId: target.beforeId, refused: target.refused });
    };
    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      endDragRef.current(true);
    };
    const onCancel = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      endDragRef.current(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !dragRef.current?.active) return;
      e.preventDefault();
      e.stopPropagation();
      endDragRef.current(false);
    };

    const drag: DragSession = {
      paneId: row.paneId,
      columnId: columnIdOf(row, stateRef.current.groupBy),
      pointerId: event.pointerId,
      kind,
      startX: event.clientX,
      startY: event.clientY,
      threshold: touch ? TOUCH_DRAG_PX : MOUSE_DRAG_PX,
      active: false,
      beforeId: null,
      refused: false,
      timer: null,
      cleanup: () => {
        if (drag.timer !== null) window.clearTimeout(drag.timer);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        try {
          if (el.hasPointerCapture(drag.pointerId)) el.releasePointerCapture(drag.pointerId);
        } catch {
          // Already released.
        }
      },
    };
    dragRef.current = drag;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    if (kind === "menu") {
      drag.timer = window.setTimeout(() => {
        drag.timer = null;
        if (dragRef.current !== drag) return;
        endDragRef.current(false);
        // The finger lifting after this would otherwise click the card open.
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 700);
        openMenu(row, drag.startX, drag.startY);
      }, LONG_PRESS_MS);
    }
  };

  const onCardMenu = (row: BoardAgent, x: number, y: number, fromPointer: boolean) => {
    // A finger's long press is handled above; this is the mouse's right
    // click and the keyboard's menu key.
    if (fromPointer && lastPointerTypeRef.current !== "mouse") return;
    openMenu(row, x, y);
  };

  // A board torn down mid-drag (tab closed, extension disabled) must not
  // leave window listeners behind.
  useEffect(() => () => dragRef.current?.cleanup(), []);

  const onCardOpen = (row: BoardAgent) => {
    if (suppressClickRef.current) return;
    openTerminal(row);
  };

  // ---- Scope controls ----
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selectedButtonRef = useRef<HTMLButtonElement>(null);

  const setScope = (mode: ScopeMode) => {
    updateState({ scope: mode });
    setPickerOpen(mode === "selected");
  };
  const onSelectedClick = () => {
    if (state.scope !== "selected") setScope("selected");
    else setPickerOpen((open) => !open);
  };
  const toggleSelected = (repo: string) => {
    const selected = stateRef.current.selected;
    updateState({ selected: selected.includes(repo) ? selected.filter((r) => r !== repo) : [...selected, repo] });
  };

  useEffect(() => {
    if (!pickerOpen) return;
    pickerRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (pickerRef.current?.contains(target) || selectedButtonRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPickerOpen(false);
      selectedButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [pickerOpen]);

  // Every project with an agent, plus any you selected that has none right
  // now: a selection is never dropped behind your back.
  const pickerEntries = useMemo(() => {
    const known = new Set(allProjects.map((p) => p.repo));
    const missing = state.selected
      .filter((repo) => !known.has(repo))
      .map((repo) => {
        const name = repo.split("/").filter(Boolean).pop() ?? repo;
        return { repo, project: name, title: name, count: 0 };
      });
    return [...allProjects, ...missing];
  }, [allProjects, state.selected]);

  // ---- Empty states ----
  const showAll = { label: "Show All Projects", run: () => setScope("all") };
  const choose = {
    label: "Choose Projects",
    run: () => {
      updateState({ scope: "selected" });
      setPickerOpen(true);
    },
  };
  let empty: { text: string; actions: { label: string; run: () => void }[] } | null = null;
  if (rows !== null) {
    if (rows.length === 0) {
      empty = {
        text: "No coding agents are running. Start Claude Code, Codex or any agent listed in Settings - AI Providers in a terminal, and it shows up here.",
        actions: [],
      };
    } else if (state.scope === "current" && currentResolved && !currentRepo) {
      empty = { text: "The tab you came from isn't in a project.", actions: [showAll] };
    } else if (state.scope === "current" && currentRepo && scopedRows.length === 0) {
      empty = { text: `No agents are running in ${currentInfo?.project ?? "this project"}.`, actions: [showAll] };
    } else if (state.scope === "selected" && state.selected.length === 0) {
      empty = { text: "No projects selected.", actions: [choose] };
    } else if (state.scope === "selected" && scopedRows.length === 0) {
      empty = { text: "None of the selected projects has an agent running.", actions: [choose, showAll] };
    }
  }

  // ---- Readout ----
  let readout: string;
  if (rows === null) readout = "Loading…";
  else if (state.scope === "current") {
    readout = currentInfo ? `${currentInfo.project} · ${plural(scopedRows.length, "agent", "agents")}` : plural(scopedRows.length, "agent", "agents");
  } else {
    const projects = new Set(scopedRows.map((row) => row.repo)).size;
    readout = `${plural(scopedRows.length, "agent", "agents")} · ${plural(projects, "project", "projects")}`;
  }
  const stale = failed && updatedAt !== null ? `Last updated ${relativeTime(updatedAt, now)} ago` : failed ? "Can't reach the server" : "";

  const scopeButton = (mode: ScopeMode, label: string) => (
    <button
      type="button"
      className="agent-board-seg-button"
      aria-pressed={state.scope === mode}
      onClick={() => (mode === "selected" ? onSelectedClick() : setScope(mode))}
      ref={mode === "selected" ? selectedButtonRef : undefined}
      aria-haspopup={mode === "selected" ? "dialog" : undefined}
      aria-expanded={mode === "selected" ? pickerOpen : undefined}
    >
      {label}
    </button>
  );
  const groupButton = (groupBy: GroupBy, label: string) => (
    <button type="button" className="agent-board-seg-button" aria-pressed={state.groupBy === groupBy} onClick={() => updateState({ groupBy })}>
      {label}
    </button>
  );

  const loadingColumns = rows === null && state.groupBy === "status";
  const shownColumns: Column[] = loadingColumns ? columnsFor([], "status", []) : columns;

  return (
    <div className="agent-board" ref={boardRef}>
      <div className="agent-board-toolbar">
        <div className="agent-board-seg" role="group" aria-label="Scope">
          {scopeButton("current", "This Project")}
          {scopeButton("all", "All Projects")}
          {scopeButton("selected", state.selected.length > 0 ? `Selected (${state.selected.length})` : "Selected…")}
        </div>
        <div className="agent-board-seg" role="group" aria-label="Group by">
          {groupButton("status", "Status")}
          {groupButton("project", "Project")}
        </div>
        <div className="agent-board-readout">
          <span className={failed ? "agent-board-count agent-board-count-stale" : "agent-board-count"}>{readout}</span>
          {stale && <span className="agent-board-stale">{stale}</span>}
          {state.order.length > 0 && (
            <button type="button" className="agent-board-link" onClick={() => updateState({ order: [] })} title="Forget the order you dragged cards into">
              Reset Order
            </button>
          )}
        </div>
        {pickerOpen && (
          <div className="agent-board-picker" role="dialog" aria-label="Choose projects" ref={pickerRef}>
            {pickerEntries.length === 0 ? (
              <p className="agent-board-picker-empty">No project has an agent running.</p>
            ) : (
              pickerEntries.map((entry) => (
                <label key={entry.repo} className={entry.count === 0 ? "agent-board-picker-row agent-board-picker-row-gone" : "agent-board-picker-row"} title={entry.repo}>
                  <input type="checkbox" checked={state.selected.includes(entry.repo)} onChange={() => toggleSelected(entry.repo)} />
                  <span className="agent-board-picker-name">{entry.title}</span>
                  <span className="agent-board-picker-count">{entry.count}</span>
                </label>
              ))
            )}
          </div>
        )}
      </div>

      {rows !== null && !state.hookHintDismissed && looksHookless(allRows) && (
        <div className="agent-board-hint">
          <span>
            <b>Waiting on you</b> needs the agent hooks: install them in Settings - AI Providers. Without them a permission prompt looks the same as a finished turn.
          </span>
          <button type="button" className="agent-board-link" onClick={() => updateState({ hookHintDismissed: true })}>
            Dismiss
          </button>
        </div>
      )}

      {empty ? (
        <div className="agent-board-empty">
          <p>{empty.text}</p>
          {empty.actions.length > 0 && (
            <div className="agent-board-empty-actions">
              {empty.actions.map((action) => (
                <button key={action.label} type="button" className="agent-board-button" onClick={action.run}>
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : rows === null && state.groupBy === "project" ? (
        <div className="agent-board-empty">
          <p>Loading agents…</p>
        </div>
      ) : (
        <div className={`agent-board-columns agent-board-columns-${state.groupBy}`}>
          {shownColumns.map((col) => {
            const endDrop = !!dragView && !dragView.refused && dragView.beforeId === null && dragView.columnId === col.id;
            return (
              <section
                key={col.id}
                className={endDrop ? "agent-board-column agent-board-column-drop-end" : "agent-board-column"}
                data-column-id={col.id}
                aria-label={`${col.title}, ${plural(col.cards.length, "agent", "agents")}`}
              >
                <header className="agent-board-column-header">
                  {col.mark && <HeaderMark mark={col.mark} />}
                  <span className="agent-board-column-title" title={state.groupBy === "project" ? col.id : undefined}>
                    {col.title}
                  </span>
                  <span className="agent-board-column-count">{loadingColumns ? "" : col.cards.length}</span>
                </header>
                <div className="agent-board-cards">
                  {col.cards.map((row) => {
                    const dragging = dragView?.paneId === row.paneId ? dragView : null;
                    return (
                      <BoardCard
                        key={row.paneId}
                        row={row}
                        now={now}
                        showProject={state.groupBy === "status"}
                        dragOffset={dragging ? { x: dragging.dx, y: dragging.dy } : null}
                        refused={dragging?.refused ?? false}
                        returning={returningId === row.paneId}
                        dropBefore={!!dragView && !dragView.refused && dragView.beforeId === row.paneId}
                        onPointerDown={onCardPointerDown}
                        onOpen={onCardOpen}
                        onMenu={onCardMenu}
                      />
                    );
                  })}
                  {col.cards.length === 0 && (
                    <p className="agent-board-placeholder">{loadingColumns ? "Loading…" : (EMPTY_COLUMN_TEXT[col.id] ?? "No agents")}</p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
