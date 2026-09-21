// The board's columns: which statuses each holds, and where a ticket whose
// status no column claims ends up. One global configuration, saved in the
// jira.board setting (written by the board's column editor, not declared in
// the manifest), shared by both lists' boards.
//
// Everything here only arranges tickets already fetched - the board never
// changes a ticket's status.
import type { IssueRow } from "./types.ts";

export interface BoardColumn {
  id: string;
  name: string;
  statuses: string[];
  // One of COLUMN_COLORS, or absent for none.
  color?: ColumnColor | null;
}

// A fixed palette rather than any colour: each is a mid-strength hue chosen
// to read on light and dark themes alike, which an arbitrary hex picked
// against one theme would not. Stored by name, so the palette can be retuned
// without rewriting anyone's saved board.
export const COLUMN_COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;
export type ColumnColor = (typeof COLUMN_COLORS)[number];

export function isColumnColor(value: unknown): value is ColumnColor {
  return typeof value === "string" && (COLUMN_COLORS as readonly string[]).includes(value);
}

export interface BoardConfig {
  columns: BoardColumn[];
  // Leave statuses no column claims off the board, rather than giving each
  // a column of its own. Only takes effect once a column is configured -
  // with none, every status is unclaimed and the board would be empty.
  hideUnassigned?: boolean;
}

export const EMPTY_BOARD: BoardConfig = Object.freeze({ columns: [] }) as BoardConfig;

// Jira's three status categories, in the order work moves through them.
export const CATEGORY_ORDER = ["new", "indeterminate", "done"] as const;

function categoryRank(category: string | null): number {
  const rank = CATEGORY_ORDER.indexOf(category as (typeof CATEGORY_ORDER)[number]);
  // An unknown category sorts after every known one.
  return rank === -1 ? CATEGORY_ORDER.length : rank;
}

// ---- Reading and writing the setting ----

// A mangled value reads as no configuration - every status its own column -
// rather than breaking the board. A status listed in two columns keeps only
// the first, since a ticket can only stand in one place.
export function parseBoardConfig(raw: unknown): BoardConfig {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return EMPTY_BOARD;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return EMPTY_BOARD;
    }
  }
  const list = (parsed as { columns?: unknown } | null)?.columns;
  if (!Array.isArray(list)) return EMPTY_BOARD;
  const hideUnassigned = (parsed as { hideUnassigned?: unknown }).hideUnassigned === true;
  const seenIds = new Set<string>();
  const seenStatuses = new Set<string>();
  const columns: BoardColumn[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    let id = typeof raw.id === "string" && raw.id ? raw.id : "";
    if (!id || seenIds.has(id)) id = nextId({ columns }, seenIds);
    seenIds.add(id);
    const statuses = (Array.isArray(raw.statuses) ? raw.statuses : [])
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .filter((s) => (seenStatuses.has(s) ? false : (seenStatuses.add(s), true)));
    const column: BoardColumn = { id, name: typeof raw.name === "string" ? raw.name : "", statuses };
    // An unknown colour name is dropped rather than trusted into a style.
    if (isColumnColor(raw.color)) column.color = raw.color;
    columns.push(column);
  }
  return hideUnassigned ? { columns, hideUnassigned } : { columns };
}

export function serializeBoardConfig(config: BoardConfig): string {
  return JSON.stringify(config.hideUnassigned ? { columns: config.columns, hideUnassigned: true } : { columns: config.columns });
}

export function setHideUnassigned(config: BoardConfig, hide: boolean): BoardConfig {
  const { hideUnassigned: _old, ...rest } = config;
  return hide ? { ...rest, hideUnassigned: true } : rest;
}

// Whether the hide option is actually in force - see BoardConfig.
export function hidingUnassigned(config: BoardConfig): boolean {
  return config.hideUnassigned === true && config.columns.length > 0;
}

// Tickets whose status no configured column claims. With hiding on, these
// are the tickets the board is not showing, and the toolbar says how many.
export function unplacedIssues(config: BoardConfig, issues: readonly IssueRow[]): IssueRow[] {
  const claimed = new Set(config.columns.flatMap((c) => c.statuses));
  return issues.filter((issue) => !claimed.has(issue.status));
}

// ---- Editing ----

function nextId(config: BoardConfig, taken: ReadonlySet<string> = new Set()): string {
  let n = 1;
  const used = new Set([...taken, ...config.columns.map((c) => c.id)]);
  while (used.has(`col-${n}`)) n++;
  return `col-${n}`;
}

export function addColumn(config: BoardConfig, name: string): BoardConfig {
  return { ...config, columns: [...config.columns, { id: nextId(config), name, statuses: [] }] };
}

export function renameColumn(config: BoardConfig, id: string, name: string): BoardConfig {
  return { ...config, columns: config.columns.map((c) => (c.id === id ? { ...c, name } : c)) };
}

export function setColumnColor(config: BoardConfig, id: string, color: ColumnColor | null): BoardConfig {
  return {
    ...config,
    columns: config.columns.map((c) => {
      if (c.id !== id) return c;
      const { color: _old, ...rest } = c;
      return color ? { ...rest, color } : rest;
    }),
  };
}

export function moveColumn(config: BoardConfig, id: string, delta: number): BoardConfig {
  const from = config.columns.findIndex((c) => c.id === id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= config.columns.length) return config;
  const columns = [...config.columns];
  const [moved] = columns.splice(from, 1);
  columns.splice(to, 0, moved);
  return { ...config, columns };
}

export function removeColumn(config: BoardConfig, id: string): BoardConfig {
  return { ...config, columns: config.columns.filter((c) => c.id !== id) };
}

// A status belongs to one column at most: giving it to a column takes it from
// whichever column held it before.
export function assignStatus(config: BoardConfig, status: string, columnId: string): BoardConfig {
  return {
    ...config,
    columns: config.columns.map((c) => {
      const without = c.statuses.filter((s) => s !== status);
      return c.id === columnId ? { ...c, statuses: [...without, status] } : { ...c, statuses: without };
    }),
  };
}

export function unassignStatus(config: BoardConfig, status: string): BoardConfig {
  return { ...config, columns: config.columns.map((c) => ({ ...c, statuses: c.statuses.filter((s) => s !== status) })) };
}

// The 0-based position of the first column without a name, or null when every
// column has one.
export function validateBoard(config: BoardConfig): number | null {
  const index = config.columns.findIndex((c) => !c.name.trim());
  return index === -1 ? null : index;
}

export function unassignedStatuses(config: BoardConfig, known: readonly string[]): string[] {
  const assigned = new Set(config.columns.flatMap((c) => c.statuses));
  return known.filter((status) => !assigned.has(status));
}

// ---- Laying tickets out ----

export interface ResolvedColumn {
  id: string;
  name: string;
  statuses: string[];
  // A configured column's colour; a leftover-status column never has one.
  color?: ColumnColor | null;
  // False for a column made for a status no configured column claims.
  configured: boolean;
  issues: IssueRow[];
}

// Configured columns come first, in the order they were set up, and show even
// when empty. A status no configured column claims gets a column of its own
// after them - but only while a ticket on the board has it, since offering
// one for every status Jira knows would bury the board in empty columns -
// ordered To Do statuses first and Done last, then by name. (It used to be
// slotted in beside the configured column of the same category; the columns
// you define are the board's shape, so they now always lead.) With the hide
// option on, those extra columns are left out altogether.
//
// With nothing configured, every status on the board is its own column, in
// that same category order. Tickets keep their input order - the chosen
// sort - inside every column.
export function resolveColumns(
  config: BoardConfig,
  issues: readonly IssueRow[],
  categoryOf: (status: string) => string | null,
): ResolvedColumn[] {
  const configured: ResolvedColumn[] = config.columns.map((c) => ({ ...c, configured: true, issues: [] }));
  const home = new Map<string, number>();
  configured.forEach((column, i) => column.statuses.forEach((status) => home.set(status, i)));

  const leftovers = new Map<string, ResolvedColumn>();
  for (const issue of issues) {
    const index = home.get(issue.status);
    if (index !== undefined) {
      configured[index].issues.push(issue);
      continue;
    }
    let column = leftovers.get(issue.status);
    if (!column) {
      column = { id: `status:${issue.status}`, name: issue.status, statuses: [issue.status], configured: false, issues: [] };
      leftovers.set(issue.status, column);
    }
    column.issues.push(issue);
  }

  const byCategory = (a: ResolvedColumn, b: ResolvedColumn) =>
    categoryRank(categoryOf(a.name)) - categoryRank(categoryOf(b.name)) || a.name.localeCompare(b.name);
  const extras = [...leftovers.values()].sort(byCategory);
  if (configured.length === 0) return extras;
  if (hidingUnassigned(config)) return configured;
  return [...configured, ...extras];
}
