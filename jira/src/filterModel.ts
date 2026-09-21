// The panel's filter state: what is ticked, how it reaches server.js, how it
// reads as chips, and where it is remembered between sessions.
//
// Filters narrow the QUERY, not the rows that came back - see server.js's
// "Filters -> JQL" section for why. This module's job is only to hold the
// selections and hand them over as request parameters; it never filters an
// issue list itself, and deliberately has no function that could.
import type { Facets } from "./types.ts";

export type FacetKey = "status" | "assignee" | "type" | "priority";

export const FACET_KEYS: readonly FacetKey[] = ["status", "assignee", "type", "priority"];

// The sentinel for "nobody". Jira has no accountId for unassigned, and
// server.js turns this exact value into `assignee is EMPTY`.
export const UNASSIGNED = "unassigned";

export interface IssueFilters {
  status: string[];
  assignee: string[];
  type: string[];
  priority: string[];
  text: string;
}

export const EMPTY_FILTERS: IssueFilters = Object.freeze({
  status: [],
  assignee: [],
  type: [],
  priority: [],
  text: "",
}) as IssueFilters;

// What the funnel's badge shows: every ticked value, plus the search box when
// it holds anything. Counting facets rather than values would say "1" for
// three ticked statuses, which reads as a narrower filter than it is.
export function activeCount(filters: IssueFilters): number {
  return FACET_KEYS.reduce((total, facet) => total + filters[facet].length, 0) + (filters.text ? 1 : 0);
}

export function isEmpty(filters: IssueFilters): boolean {
  return activeCount(filters) === 0;
}

export function toggleValue(filters: IssueFilters, facet: FacetKey, value: string): IssueFilters {
  const current = filters[facet];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return { ...filters, [facet]: next };
}

export function removeValue(filters: IssueFilters, facet: FacetKey, value: string): IssueFilters {
  return { ...filters, [facet]: filters[facet].filter((v) => v !== value) };
}

export function setText(filters: IssueFilters, text: string): IssueFilters {
  return { ...filters, text };
}

// ---- Display ----

export interface FilterChip {
  facet: FacetKey | "text";
  value: string;
  label: string;
}

// An assignee is stored as its Jira accountId, which is unreadable, so the
// display name comes from the facet list the popover was built from. Falling
// back to the raw value keeps the chip visible while that list is still
// loading - dropping it would hide a filter that is nonetheless applied.
export function facetLabel(facet: FacetKey, value: string, facets: Facets | null): string {
  if (facet !== "assignee") return value;
  if (value === UNASSIGNED) return "Unassigned";
  return facets?.assignees.find((user) => user.accountId === value)?.displayName ?? value;
}

export function chipsOf(filters: IssueFilters, facets: Facets | null): FilterChip[] {
  const chips: FilterChip[] = [];
  if (filters.text) chips.push({ facet: "text", value: filters.text, label: `"${filters.text}"` });
  for (const facet of FACET_KEYS) {
    for (const value of filters[facet]) {
      chips.push({ facet, value, label: facetLabel(facet, value, facets) });
    }
  }
  return chips;
}

// Repeated params, matching readFilterParams in server.js: a status name can
// itself contain a comma, so a comma-joined value would invent facet values
// that never existed.
export function filterParams(filters: IssueFilters): [string, string][] {
  const params: [string, string][] = [];
  for (const facet of FACET_KEYS) {
    for (const value of filters[facet]) params.push([facet, value]);
  }
  if (filters.text) params.push(["text", filters.text]);
  return params;
}

// ---- Persistence ----

export type ListId = "mine" | "project";

const LIST_IDS: readonly ListId[] = ["mine", "project"];

// jira.filters as it sits in the settings document: keyed by repo path, then
// by pane. Written by the panel but NOT declared in the manifest, so no row
// for it appears in Settings - it is machine-written panel state rewritten on
// every tick, and a text field for it would only invite hand-editing.
export type FilterStore = Record<string, Partial<Record<ListId, IssueFilters>>>;

function sanitize(value: unknown): IssueFilters | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const list = (facet: FacetKey): string[] =>
    Array.isArray(raw[facet]) ? (raw[facet] as unknown[]).filter((v): v is string => typeof v === "string") : [];
  const filters: IssueFilters = {
    status: list("status"),
    assignee: list("assignee"),
    type: list("type"),
    priority: list("priority"),
    text: typeof raw.text === "string" ? raw.text : "",
  };
  return isEmpty(filters) ? null : filters;
}

// Settings values arrive as the JSON string the document holds, but an object
// is accepted too so a caller that already parsed it isn't forced to
// re-stringify. A mangled value reads as "nothing saved" rather than throwing:
// a broken filter must never stop the panel from listing issues.
export function parseFilterStore(raw: unknown): FilterStore {
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

  const store: FilterStore = {};
  for (const [repo, byList] of Object.entries(parsed as Record<string, unknown>)) {
    if (!byList || typeof byList !== "object" || Array.isArray(byList)) continue;
    const entry: Partial<Record<ListId, IssueFilters>> = {};
    for (const list of LIST_IDS) {
      const filters = sanitize((byList as Record<string, unknown>)[list]);
      if (filters) entry[list] = filters;
    }
    if (Object.keys(entry).length > 0) store[repo] = entry;
  }
  return store;
}

export function readFilters(store: FilterStore, repo: string | null, list: ListId): IssueFilters {
  if (!repo) return EMPTY_FILTERS;
  return store[repo]?.[list] ?? EMPTY_FILTERS;
}

// An emptied pane drops its entry, and a repo left with no panes drops out
// entirely. Without the pruning the setting would only ever grow, one dead
// repo path at a time, for every repo ever opened.
export function writeFilters(
  store: FilterStore,
  repo: string,
  list: ListId,
  filters: IssueFilters,
): FilterStore {
  const next: FilterStore = { ...store };
  const entry: Partial<Record<ListId, IssueFilters>> = { ...(next[repo] ?? {}) };
  if (isEmpty(filters)) delete entry[list];
  else entry[list] = filters;
  if (Object.keys(entry).length === 0) delete next[repo];
  else next[repo] = entry;
  return next;
}

export function serializeFilterStore(store: FilterStore): string {
  return JSON.stringify(store);
}
