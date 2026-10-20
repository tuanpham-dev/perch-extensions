// agent-monitor: every terminal window running one of the agents in the app's own
// registry (Settings → AI Providers), classified working/waiting/done/idle and
// shown as a status mark on that window's own PROJECTS-pane row, in Orca's
// vocabulary: a spinner, an amber "?", an emerald dot, a red dot for a turn
// that was interrupted, and a gray dot for idle. Host hooks arrive
// via module-level bridge variables set once in activate(), same pattern as
// every other bundled-style extension (search, git-scm, worktrees).
//
// No settings section of its own any more: the hook snippet, the install
// button and the "have any events arrived" readout all live in core's
// Settings → AI Providers now, for every agent at once rather than for Claude
// Code alone (plans/agent-platform-core.md).
import "./style.css";
import { useEffect, useState, type ComponentType } from "react";
import { injectStylesheet } from "./injectStylesheet";
import BoardView from "./BoardView";
import AgentsPanelView from "./AgentsPanelView";
import Icon from "./Icon";
import { attentionSummary, gridWindowsFor, labelOf, loadBoardState, markOf, type BoardAgent, type GridWindow } from "./boardModel";
import { host, type AppApi, type SettingsApi } from "./host";

// ---- Module-level host bridge ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let removeStylesheet: (() => void) | null = null;

// ---- Types (mirror server.js's /agents response) ----

interface AgentRow {
  sessionName: string;
  windowIndex: number;
  windowName: string;
  command: string;
  cwd: string;
  // idle: quiet for 30 minutes without reporting that it finished, or no
  // signal at all for this pane.
  state: "working" | "waiting" | "done" | "idle";
  // A done turn the user cancelled (the stop hook's is_interrupt).
  interrupted?: boolean;
  // Why the agent is waiting: a permission prompt, or a question it asked
  // the user (Claude's AskUserQuestion, Codex's request_user_input). Both
  // block on a human and both get the "?" badge.
  stateDetail?: "permission" | "question";
  taskLabel?: string;
  // From the hooks, when they are installed: the turn's prompt and the tool
  // in flight - Orca's readout, so the tooltip says what the agent is doing
  // rather than only that it is doing something.
  prompt?: string;
  toolName?: string;
  lastActivityAt: number | null;
}

async function fetchAgents(): Promise<AgentRow[]> {
  if (!serverFetch) return [];
  const res = await serverFetch("/agents");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { agents: AgentRow[] };
  return body.agents;
}

function rowKey(row: AgentRow): string {
  return `${row.sessionName}:${row.windowIndex}`;
}

// ---- Window-row decoration (PROJECTS pane) ----
//
// This app is designed 1 window per tab, so a (sessionName, windowIndex)
// pair identifies at most one agent pane in practice — no merge rule needed
// for multiple agents sharing a row. Every agent window gets a mark, done
// included: Orca's sidebar shows a finished agent as an emerald dot, and
// that is exactly the "which of my agents can I look at now" answer. Only a
// window that is not an agent (a plain shell) has none, because the server
// never lists it.
let agentsByWindowKey = new Map<string, AgentRow>();
let refreshDecorations: (() => void) | null = null;

// markOf/labelOf live in boardModel.ts: the PROJECTS mark and the AGENTS
// board describe a state in the same words, from one place.

function decorationFor(row: AgentRow | undefined): { badge: string; tooltip: string; className: string } | undefined {
  if (!row) return undefined;
  const mark = markOf(row);
  const label = labelOf(row, mark);
  // The task label from the title, else the prompt from the hook: what the
  // agent is on, in one line.
  const context = row.taskLabel ?? row.prompt;
  return {
    // Shape first, color second. Waiting is the one state blocking YOU, so
    // it is a "?" rather than another shade of dot, and working is a spinner:
    // both read before their color does. The dots' "●" is hidden by the
    // stylesheet; it is only there so the badge is never empty.
    badge: mark === "waiting" ? "?" : "●",
    tooltip: context ? `${label} - ${context}` : label,
    className: `agent-monitor-badge-${mark}`,
  };
}

// ---- Activation ----

interface SessionDecorationContext {
  sessionName: string;
  windowIndex: number;
  cwd: string;
  command: string;
}

interface ExtensionContext {
  registerSessionDecorationProvider(provider: {
    id: string;
    provideWindowDecoration: (
      ctx: SessionDecorationContext,
    ) => { badge: string; tooltip?: string; className?: string } | undefined;
  }): { refresh(): void };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // `global` (ignored by a host without global viewers): the tab never joins
  // a project's chip.
  registerFileViewer(viewer: { id: string; extensions: string[]; global?: boolean; component: ComponentType<any> }): void;
  registerCommand(command: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  // Optional: an older host has no managed grids, and then no Agents grid.
  registerManagedGrid?(grid: {
    id: string;
    title: string;
    icon?: string;
    emptyText?: string;
  }): { open(): void; setWindows(windows: GridWindow[]): void };
  // Optional: an older host has no bottom-panel views.
  registerPanelView?(view: {
    id: string;
    title: string;
    icon?: string;
    order?: number;
    component: typeof AgentsPanelView;
  }): void;
  // Optional: an older host has no status bar for extensions to contribute to.
  registerStatusBarItem?(item: {
    id: string;
    title?: string;
    placement?: "left" | "right";
    order?: number;
    component: typeof AgentBoardStatusItem;
  }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  app: AppApi;
  settings: SettingsApi;
}

// The one board: re-running the command focuses the tab already open rather
// than opening another, because openViewerTab keys a tab by (viewer, path).
const BOARD_VIEWER = "board";
const BOARD_PATH = "agents";

function openBoard(): void {
  host.app?.openViewerTab(BOARD_VIEWER, BOARD_PATH, { title: "Agents" });
}

// ---- Status-bar launcher ----
//
// The board is worth reaching without remembering a chord, the way Git Graph
// and Jira both offer theirs. Icon only, so the bar stays as narrow on a
// phone as it is on a desktop; what the counts say rides in the tooltip.
//
// Its own subscription rather than a prop: the poll below owns the agent
// list, and the item lives outside any component that could be handed it.
const agentListeners = new Set<() => void>();

function useAgentRows(): AgentRow[] {
  const [rows, setRows] = useState<AgentRow[]>(() => [...agentsByWindowKey.values()]);
  useEffect(() => {
    const read = () => setRows([...agentsByWindowKey.values()]);
    agentListeners.add(read);
    read();
    return () => {
      agentListeners.delete(read);
    };
  }, []);
  return rows;
}

function AgentBoardStatusItem({
  context,
}: {
  context?: { showMenu(x: number, y: number, items: { label: string; icon?: string; onClick: () => void }[]): void };
}) {
  const rows = useAgentRows();
  const summary = attentionSummary(rows);
  const waiting = rows.some((r) => r.state === "waiting");
  return (
    <button
      className="status-bar-item"
      title={summary ? `Open the Agents board - ${summary}` : "Open the Agents board"}
      aria-label="Open the Agents board"
      onClick={openBoard}
      onContextMenu={(e) => {
        const grid = host.grid;
        if (!grid || !context) return;
        // The bar's own right-click menu (which items to show) would
        // replace this one.
        e.preventDefault();
        e.stopPropagation();
        context.showMenu(e.clientX, e.clientY, [
          { label: "Open Agent Board", icon: "robot", onClick: openBoard },
          { label: "Open Agent Grid", icon: "layout", onClick: () => grid.open(null) },
        ]);
      }}
    >
      {/* Amber while an agent is blocked on you, the same signal and the
          same hue as the "?" mark on its PROJECTS row - the one state that
          is asking for you rather than reporting at you. */}
      <Icon name="robot" className={waiting ? "agent-monitor-statusbar-waiting" : undefined} />
    </button>
  );
}

// 5s: the Agents grid adds a started agent and drops an exited one on this
// beat, and core caches the process scan behind it.
const POLL_MS = 5_000;
let pollTimer: number | null = null;

// ---- Agents grid ----
//
// A grid tab of every agent's live terminal, through core's managed-grid API
// (core adds, removes and hides cells; this only says which windows). The
// board's scope decides which, read from the board's own saved state on
// every poll, so the board and the grid show the same agents. "This Project"
// pins the project the grid was opened for: following the active tab would
// re-scope the grid each time a cell takes focus.
const GRID_REPO_KEY = "agent-monitor.grid.currentRepo";
let gridHandle: { open(): void; setWindows(windows: GridWindow[]): void } | null = null;
let gridCurrentRepo: string | null = readGridRepo();

function readGridRepo(): string | null {
  try {
    return window.localStorage.getItem(GRID_REPO_KEY);
  } catch {
    return null;
  }
}

function writeGridRepo(repo: string | null): void {
  gridCurrentRepo = repo;
  try {
    if (repo === null) window.localStorage.removeItem(GRID_REPO_KEY);
    else window.localStorage.setItem(GRID_REPO_KEY, repo);
  } catch {
    // Storage blocked: the pin lasts for this page only.
  }
}

function syncGrid(): void {
  if (!gridHandle) return;
  const state = loadBoardState(host.settings?.get("agentMonitor.board.defaultScope"));
  const rows = [...agentsByWindowKey.values()] as unknown as BoardAgent[];
  gridHandle.setWindows(gridWindowsFor(rows, { mode: state.scope, selected: state.selected, currentRepo: gridCurrentRepo }));
}

async function activeRepo(): Promise<string | null> {
  const cwd = host.app?.getActiveContext().cwd;
  if (!cwd || !serverFetch) return null;
  try {
    const res = await serverFetch(`/project?cwd=${encodeURIComponent(cwd)}`);
    if (!res.ok) return null;
    const info = (await res.json()) as { repo?: string } | null;
    return info?.repo || null;
  } catch {
    return null;
  }
}

async function openGrid(currentRepo: string | null): Promise<void> {
  if (!gridHandle) return;
  writeGridRepo(currentRepo ?? (await activeRepo()) ?? gridCurrentRepo);
  syncGrid();
  gridHandle.open();
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  host.serverFetch = ctx.serverFetch;
  host.app = ctx.app;
  host.settings = ctx.settings;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  // extensions: [] - the board is never matched to a file; it is reached only
  // through openViewerTab. Global: the board scopes itself (current repo,
  // selected repos or all), so its tab stays put across projects rather than
  // joining the chip of the project it was opened from.
  ctx.registerFileViewer({ id: BOARD_VIEWER, extensions: [], global: true, component: BoardView });
  ctx.registerCommand({
    id: "openBoard",
    label: "Agent Board: Open",
    defaultBinding: "ctrl+shift+alt+KeyA",
    run: openBoard,
  });
  gridHandle =
    ctx.registerManagedGrid?.({
      id: "agents",
      title: "Agents Grid",
      icon: "robot",
      emptyText: "No agents in this scope. Start Claude Code or Codex in a terminal, or widen the scope on the Agents board.",
    }) ?? null;
  if (gridHandle) {
    host.grid = { open: (repo) => void openGrid(repo), refresh: syncGrid };
    ctx.registerCommand({ id: "openGrid", label: "Agent Grid: Open", run: () => void openGrid(null) });
  }

  // Left group, after Git Graph (1) and Jira (2): the launchers sit together,
  // and core's own readouts keep the right end.
  ctx.registerStatusBarItem?.({
    id: "openBoard",
    title: "Agent Board",
    placement: "left",
    order: 3,
    component: AgentBoardStatusItem,
  });

  // The AGENTS view in the bottom panel: the same rows as the board, as a
  // table with the hook-event feed under it. Only on a host that has views.
  ctx.registerPanelView?.({
    id: "agents",
    title: "Agents",
    icon: "robot",
    order: 20,
    component: AgentsPanelView,
  });

  refreshDecorations = ctx.registerSessionDecorationProvider({
    id: "agents",
    provideWindowDecoration(win) {
      return decorationFor(agentsByWindowKey.get(`${win.sessionName}:${win.windowIndex}`));
    },
  }).refresh;

  const poll = () => {
    fetchAgents()
      .then((rows) => {
        agentsByWindowKey = new Map(rows.map((r) => [rowKey(r), r]));
        refreshDecorations?.();
        for (const listener of agentListeners) listener();
        syncGrid();
      })
      .catch(() => {
        // Transient — next poll retries.
      });
  };
  poll();
  pollTimer = window.setInterval(poll, POLL_MS);
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  host.serverFetch = null;
  host.app = null;
  host.settings = null;
  host.grid = null;
  gridHandle = null;
  refreshDecorations = null;
  agentsByWindowKey = new Map();
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}
