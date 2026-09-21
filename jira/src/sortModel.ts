// How a list is ordered and whether it is grouped - the list's "view", as
// opposed to its filters. Sorting is done by Jira (the choice becomes the
// query's ORDER BY - see server.js's composeJql); grouping only arranges the
// rows that came back.
//
// Kept apart from the filters on purpose, in its own jira.listViews setting:
// Clear in the filter bar rebuilds the filters from empty, and a sort stored
// among them would be wiped along with them.
import type { ListId } from "./filterModel.ts";

export type SortField = "key" | "summary" | "status" | "priority" | "assignee" | "type" | "created" | "updated";
export type SortDir = "asc" | "desc";

export interface IssueSort {
  field: SortField;
  dir: SortDir;
}

export const SORT_FIELDS: readonly { field: SortField; label: string }[] = [
  { field: "key", label: "Key" },
  { field: "summary", label: "Summary" },
  { field: "status", label: "Status" },
  { field: "priority", label: "Priority" },
  { field: "assignee", label: "Assignee" },
  { field: "type", label: "Type" },
  { field: "created", label: "Created" },
  { field: "updated", label: "Updated" },
];

// Newest-updated first: the order every list had before sorting existed.
export const DEFAULT_SORT: IssueSort = Object.freeze({ field: "updated", dir: "desc" }) as IssueSort;

// Dates and priority read best highest-first; everything else A to Z.
const DESC_FIRST: ReadonlySet<SortField> = new Set(["created", "updated", "priority"]);

export function sortLabel(field: SortField): string {
  return SORT_FIELDS.find((f) => f.field === field)?.label ?? field;
}

// A heading click: the same field again flips the direction, a new field
// starts in its natural direction.
export function toggleSort(current: IssueSort, field: SortField): IssueSort {
  if (current.field === field) return { field, dir: current.dir === "asc" ? "desc" : "asc" };
  return { field, dir: DESC_FIRST.has(field) ? "desc" : "asc" };
}

export function isDefaultSort(sort: IssueSort): boolean {
  return sort.field === DEFAULT_SORT.field && sort.dir === DEFAULT_SORT.dir;
}

// The default sends nothing, so an unsorted list asks for exactly the query
// it always did.
export function sortParams(sort: IssueSort): [string, string][] {
  return isDefaultSort(sort) ? [] : [["sort", sort.field], ["dir", sort.dir]];
}

// ---- The view, and where it is remembered ----

export interface ListView {
  sort: IssueSort;
  groupByProject: boolean;
}

export const DEFAULT_VIEW: ListView = Object.freeze({ sort: DEFAULT_SORT, groupByProject: false }) as ListView;

export function isDefaultView(view: ListView): boolean {
  return isDefaultSort(view.sort) && !view.groupByProject;
}

// jira.listViews in the settings document: repo path, then list. Written by
// the panel, not declared in the manifest - like jira.filters.
export type ViewStore = Record<string, Partial<Record<ListId, ListView>>>;

const LIST_IDS: readonly ListId[] = ["mine", "project"];

function sanitizeView(value: unknown): ListView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const sortRaw = raw.sort as Record<string, unknown> | undefined;
  const field = SORT_FIELDS.some((f) => f.field === sortRaw?.field) ? (sortRaw!.field as SortField) : DEFAULT_SORT.field;
  const dir: SortDir = sortRaw?.dir === "asc" || sortRaw?.dir === "desc" ? sortRaw.dir : DEFAULT_SORT.dir;
  const view: ListView = { sort: { field, dir }, groupByProject: raw.groupByProject === true };
  return isDefaultView(view) ? null : view;
}

// A mangled value reads as "nothing saved" rather than throwing - a broken
// view must never stop a list from loading.
export function parseViewStore(raw: unknown): ViewStore {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const store: ViewStore = {};
  for (const [repo, byList] of Object.entries(parsed as Record<string, unknown>)) {
    if (!byList || typeof byList !== "object" || Array.isArray(byList)) continue;
    const entry: Partial<Record<ListId, ListView>> = {};
    for (const list of LIST_IDS) {
      const view = sanitizeView((byList as Record<string, unknown>)[list]);
      if (view) entry[list] = view;
    }
    if (Object.keys(entry).length > 0) store[repo] = entry;
  }
  return store;
}

export function readView(store: ViewStore, repo: string | null, list: ListId): ListView {
  if (!repo) return DEFAULT_VIEW;
  return store[repo]?.[list] ?? DEFAULT_VIEW;
}

// A view back at the default drops its entry, and an emptied repo drops out,
// so the setting never grows one dead path at a time.
export function writeView(store: ViewStore, repo: string, list: ListId, view: ListView): ViewStore {
  const next: ViewStore = { ...store };
  const entry: Partial<Record<ListId, ListView>> = { ...(next[repo] ?? {}) };
  if (isDefaultView(view)) delete entry[list];
  else entry[list] = view;
  if (Object.keys(entry).length === 0) delete next[repo];
  else next[repo] = entry;
  return next;
}

export function serializeViewStore(store: ViewStore): string {
  return JSON.stringify(store);
}
