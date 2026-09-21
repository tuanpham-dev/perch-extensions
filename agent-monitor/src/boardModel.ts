// The AGENTS board's model: rows from server.js's /agents plus the view's own
// state in, columns out. No React and no host bridge here, so every rule the
// board follows - which column a card lands in, what a scope keeps, where a
// dragged card goes, what survives a reload - is a plain function the tests
// can call.

export type AgentState = "working" | "waiting" | "done" | "idle";

// What a card and a PROJECTS row show: a done turn the user cancelled is its
// own mark, a red one, but it still lives in the Done column.
export type Mark = "working" | "waiting" | "done" | "interrupted" | "idle";

// One agent window, as server.js's /agents reports it.
export interface BoardAgent {
  sessionName: string;
  windowIndex: number;
  windowName: string;
  command: string;
  cwd: string;
  // The window's stable id - the key the saved card order uses.
  paneId: string;
  agentId: string;
  agentLabel: string;
  iconUrl: string;
  icon: string;
  // The repository (or, outside one, the folder) this window belongs to.
  repo: string;
  project: string;
  branch: string | null;
  // In a linked worktree rather than the repository's own checkout.
  linked: boolean;
  state: AgentState;
  interrupted?: boolean;
  stateDetail?: "permission" | "question";
  taskLabel?: string;
  prompt?: string;
  toolName?: string;
  lastActivityAt: number | null;
}

export type ScopeMode = "current" | "all" | "selected";
export type GroupBy = "status" | "project";

export interface Scope {
  mode: ScopeMode;
  // Repository paths, for "selected".
  selected: readonly string[];
  // The active tab's repository, for "current"; null when it has none.
  currentRepo: string | null;
}

export interface Column {
  id: string;
  title: string;
  // The status mark drawn in the header; null for a project column.
  mark: Mark | null;
  cards: BoardAgent[];
}

export interface ProjectEntry {
  repo: string;
  project: string;
  // The project name, told apart from another repository of the same name
  // by its parent folder.
  title: string;
  count: number;
}

// ---- Marks and labels ----

export function markOf(row: Pick<BoardAgent, "state" | "interrupted">): Mark {
  if (row.state === "done") return row.interrupted ? "interrupted" : "done";
  return row.state;
}

// The status in words: a PROJECTS-row tooltip and a card's status line say
// the same thing.
export function labelOf(row: Pick<BoardAgent, "stateDetail" | "toolName">, mark: Mark): string {
  // The tool is the most useful word in an attention state: "permission:
  // Bash" says what is being asked, where "permission" alone only says that
  // something is.
  const tool = row.toolName ? `: ${row.toolName}` : "";
  switch (mark) {
    case "working":
      return row.toolName ? `Working - ${row.toolName}` : "Working";
    case "waiting":
      return row.stateDetail === "permission"
        ? `Waiting on you - permission${tool}`
        : row.stateDetail === "question"
          ? "Waiting on you - question"
          : "Waiting on you";
    case "done":
      return "Done";
    case "interrupted":
      return "Interrupted";
    case "idle":
      return "Idle";
  }
}

// What the agent is on, in one line: why it is waiting, else the tool in
// flight and the prompt (or the title's task label) that started the turn.
// Empty when nothing is known, and the card then shows its window alone.
export function summaryOf(row: BoardAgent): string {
  const mark = markOf(row);
  if (mark === "waiting") {
    if (row.stateDetail === "question") return "Asked you a question";
    return row.toolName ? `Permission: ${row.toolName}` : "Needs your answer";
  }
  if (mark === "interrupted") return "Interrupted";
  const text = row.prompt ?? row.taskLabel;
  const parts: string[] = [];
  if (mark === "working" && row.toolName) parts.push(row.toolName);
  if (text) parts.push(`"${text}"`);
  return parts.join(" · ");
}

// The whole fleet in one line, for the status-bar launcher's tooltip:
// "2 waiting on you, 1 working". Only the two states worth interrupting for
// - done and idle are what the board is for reading at leisure, and a
// tooltip that lists every state says nothing. Empty when neither applies,
// and the launcher then names itself alone.
export function attentionSummary(rows: readonly Pick<BoardAgent, "state">[]): string {
  const count = (state: AgentState) => rows.filter((r) => r.state === state).length;
  const waiting = count("waiting");
  const working = count("working");
  const parts: string[] = [];
  if (waiting > 0) parts.push(`${waiting} waiting on you`);
  if (working > 0) parts.push(`${working} working`);
  return parts.join(", ");
}

// ---- Projects and scope ----

function parentName(repo: string): string {
  const parts = repo.split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

// Every project with a live agent, named and counted. Two repositories that
// share a folder name (~/work/app and ~/play/app) get their parent folder in
// the title, since the name alone would make them one project to the eye.
export function projectsOf(rows: readonly BoardAgent[]): ProjectEntry[] {
  const byRepo = new Map<string, ProjectEntry>();
  for (const row of rows) {
    if (!row.repo) continue;
    const entry = byRepo.get(row.repo);
    if (entry) entry.count++;
    else byRepo.set(row.repo, { repo: row.repo, project: row.project, title: row.project, count: 1 });
  }
  const list = [...byRepo.values()];
  const nameCount = new Map<string, number>();
  for (const entry of list) nameCount.set(entry.project, (nameCount.get(entry.project) ?? 0) + 1);
  for (const entry of list) {
    if ((nameCount.get(entry.project) ?? 0) > 1) {
      const parent = parentName(entry.repo);
      if (parent) entry.title = `${entry.project} (${parent})`;
    }
  }
  return list.sort((a, b) => a.title.localeCompare(b.title) || a.repo.localeCompare(b.repo));
}

export function inScope(row: BoardAgent, scope: Scope): boolean {
  switch (scope.mode) {
    case "all":
      return true;
    case "current":
      return scope.currentRepo !== null && row.repo === scope.currentRepo;
    case "selected":
      return scope.selected.includes(row.repo);
  }
}

// ---- Columns ----

const STATUS_COLUMNS: { id: AgentState; title: string; mark: Mark }[] = [
  { id: "working", title: "Working", mark: "working" },
  { id: "waiting", title: "Waiting on you", mark: "waiting" },
  { id: "done", title: "Done", mark: "done" },
  { id: "idle", title: "Idle", mark: "idle" },
];

// Most in need of you first: only used where a column mixes states (project
// grouping), since a status column holds one.
const MARK_RANK: Record<Mark, number> = { waiting: 0, working: 1, interrupted: 2, done: 3, idle: 4 };

// Cards you placed by hand come first, in your order; the rest follow, the
// one most in need of you first and then the most recently active - so a
// newly started agent appears without disturbing an order you set.
export function sortCards(cards: readonly BoardAgent[], order: readonly string[]): BoardAgent[] {
  const position = new Map(order.map((id, index) => [id, index]));
  return [...cards].sort((a, b) => {
    const pa = position.get(a.paneId);
    const pb = position.get(b.paneId);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    const rank = MARK_RANK[markOf(a)] - MARK_RANK[markOf(b)];
    if (rank !== 0) return rank;
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  });
}

export function columnsFor(rows: readonly BoardAgent[], groupBy: GroupBy, order: readonly string[]): Column[] {
  if (groupBy === "status") {
    // All four, always, even empty: a board whose columns come and go as
    // agents change state is one you cannot learn the shape of.
    return STATUS_COLUMNS.map((col) => ({
      id: col.id,
      title: col.title,
      mark: col.mark,
      cards: sortCards(
        rows.filter((row) => row.state === col.id),
        order,
      ),
    }));
  }
  return projectsOf(rows).map((project) => ({
    id: project.repo,
    title: project.title,
    mark: null,
    cards: sortCards(
      rows.filter((row) => row.repo === project.repo),
      order,
    ),
  }));
}

// Which column a card sits in, under a grouping - what a drop is checked
// against, since a card may only move within its own column.
export function columnIdOf(row: BoardAgent, groupBy: GroupBy): string {
  return groupBy === "status" ? row.state : row.repo;
}

// ---- Card order ----

// The saved order after dragging `movedId` to sit before `beforeId` (null:
// the end) in a column currently showing `columnIds` in that order. The
// whole column becomes placed, in its new order, ahead of every other saved
// id - which keeps every other column's relative order exactly as it was,
// since a column only ever compares its own cards.
export function moveInOrder(
  order: readonly string[],
  columnIds: readonly string[],
  movedId: string,
  beforeId: string | null,
): string[] {
  if (!columnIds.includes(movedId) || movedId === beforeId) return [...order];
  const rest = columnIds.filter((id) => id !== movedId);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  const next = [...rest];
  next.splice(at < 0 ? rest.length : at, 0, movedId);
  const placed = new Set(next);
  return [...next, ...order.filter((id) => !placed.has(id))];
}

// Drops saved ids whose window is gone - but only once it has been missing
// from two polls in a row, so one poll that came back short (a session
// listing racing a rename) cannot cost you an order you set.
export function pruneOrder(
  order: readonly string[],
  presentIds: readonly string[],
  misses: Readonly<Record<string, number>>,
): { order: string[]; misses: Record<string, number> } {
  const present = new Set(presentIds);
  const nextMisses: Record<string, number> = {};
  const nextOrder: string[] = [];
  for (const id of order) {
    if (present.has(id)) {
      nextOrder.push(id);
      continue;
    }
    const count = (misses[id] ?? 0) + 1;
    if (count < 2) {
      nextOrder.push(id);
      nextMisses[id] = count;
    }
  }
  return { order: nextOrder, misses: nextMisses };
}

// ---- Time ----

export function relativeTime(at: number | null, now: number): string {
  if (at === null || !Number.isFinite(at)) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ---- Saved view state ----
//
// View state, not configuration: which scope, which projects, which grouping
// and where you dragged things are this browser's business (the same call
// git-graph makes for its per-repository filters). Only the opening default
// and the poll interval are settings.

export interface BoardState {
  scope: ScopeMode;
  selected: string[];
  groupBy: GroupBy;
  order: string[];
  hookHintDismissed: boolean;
}

export const STORAGE_KEY = "agent-monitor.board";

const SCOPES: readonly ScopeMode[] = ["current", "all", "selected"];
const GROUPINGS: readonly GroupBy[] = ["status", "project"];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function defaultBoardState(defaultScope: unknown): BoardState {
  return {
    scope: SCOPES.includes(defaultScope as ScopeMode) ? (defaultScope as ScopeMode) : "all",
    selected: [],
    groupBy: "status",
    order: [],
    hookHintDismissed: false,
  };
}

// Anything that doesn't parse, or parses into the wrong shape, falls back
// field by field to the default: a stale or hand-edited value must never be
// what breaks the board.
export function parseBoardState(raw: string | null, defaults: BoardState): BoardState {
  if (!raw) return defaults;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (!value || typeof value !== "object") return defaults;
  const v = value as Record<string, unknown>;
  return {
    scope: SCOPES.includes(v.scope as ScopeMode) ? (v.scope as ScopeMode) : defaults.scope,
    selected: isStringArray(v.selected) ? v.selected : defaults.selected,
    groupBy: GROUPINGS.includes(v.groupBy as GroupBy) ? (v.groupBy as GroupBy) : defaults.groupBy,
    order: isStringArray(v.order) ? v.order : defaults.order,
    hookHintDismissed: typeof v.hookHintDismissed === "boolean" ? v.hookHintDismissed : defaults.hookHintDismissed,
  };
}

export function loadBoardState(defaultScope: unknown): BoardState {
  const defaults = defaultBoardState(defaultScope);
  try {
    return parseBoardState(window.localStorage.getItem(STORAGE_KEY), defaults);
  } catch {
    // Storage blocked (a private window, site data cleared or refused).
    return defaults;
  }
}

export function saveBoardState(state: BoardState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Same as above: the board keeps working, it just won't remember.
  }
}

// ---- Hook hint ----

// Whether nothing on the board came from an agent hook: no prompt, no tool,
// no reason for waiting, on any row. That is what a machine without the
// app's agent hooks installed looks like, and the one case where "waiting on
// you" cannot be detected at all - worth a line pointing at the fix.
export function looksHookless(rows: readonly BoardAgent[]): boolean {
  return rows.length > 0 && rows.every((row) => !row.prompt && !row.toolName && !row.stateDetail);
}
