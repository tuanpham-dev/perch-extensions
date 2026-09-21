// What the graph is showing, and what a search in it matches.
//
// Two separate ideas live here, and the difference matters for the lanes:
//
//   - The FILTER narrows what `git log` walks - which refs, whose commits.
//     The server applies it, so it can reach commits far beyond the loaded
//     page. Narrowing by author drops commits from the middle of the DAG,
//     which leaves the remaining rows with parents that are no longer there;
//     `graphIsTruthful` is what tells the view to stop drawing lanes rather
//     than draw lines that don't exist.
//   - The SEARCH matches what is already loaded, in the browser, and by
//     default only highlights. It never changes which commits were walked,
//     so the graph stays intact while you step through the hits.

export interface GraphFilter {
  // Refs to walk. Empty means "every ref the three toggles below allow",
  // which is the default and by far the common case.
  refs: string[];
  // Author names, OR-ed together. Empty means everyone.
  authors: string[];
  showRemotes: boolean;
  showTags: boolean;
  showStashes: boolean;
}

// The settings' values, which seed a repository's filter the first time its
// graph is opened. After that the repository's own choice wins - changing a
// setting doesn't reach back into a graph you already told what to show.
export interface FilterDefaults {
  showRemotes: boolean;
  showTags: boolean;
  showStashes: boolean;
}

export function defaultFilter(defaults: FilterDefaults): GraphFilter {
  return {
    refs: [],
    authors: [],
    showRemotes: defaults.showRemotes,
    showTags: defaults.showTags,
    showStashes: defaults.showStashes,
  };
}

// True while every commit's parents are still in the walk, which is what the
// lane drawing assumes. An author filter breaks that; picking refs does not,
// because a ref selection walks whole histories.
export function graphIsTruthful(filter: GraphFilter): boolean {
  return filter.authors.length === 0;
}

// The toolbar button's label. Named refs win over the toggles because that
// is the narrower, more surprising state to be in.
export function branchSummary(filter: GraphFilter): string {
  if (filter.refs.length === 1) return filter.refs[0];
  if (filter.refs.length > 1) return `${filter.refs.length} refs`;
  return "All branches";
}

export function authorSummary(filter: GraphFilter): string {
  if (filter.authors.length === 1) return filter.authors[0];
  if (filter.authors.length > 1) return `${filter.authors.length} authors`;
  return "All authors";
}

// The parts of the filter the server needs. Booleans are sent only when
// false: the routes default them on, and a shorter query string is easier to
// read in the network panel.
export function filterQuery(filter: GraphFilter, params: URLSearchParams): URLSearchParams {
  for (const ref of filter.refs) params.append("refs", ref);
  for (const author of filter.authors) params.append("authors", author);
  if (!filter.showRemotes) params.set("remotes", "0");
  if (!filter.showTags) params.set("tags", "0");
  if (!filter.showStashes) params.set("stashes", "0");
  return params;
}

// ---- Per-repository persistence ----
//
// Keyed by root: two repositories open in two tabs keep their own choices,
// and closing a tab doesn't throw away the filter it was showing.

const STORAGE_PREFIX = "gitGraph.filter:";

export function loadFilter(root: string, defaults: FilterDefaults): GraphFilter {
  const fallback = defaultFilter(defaults);
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + root);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<GraphFilter>;
    return {
      refs: Array.isArray(saved.refs) ? saved.refs.filter((r) => typeof r === "string") : fallback.refs,
      authors: Array.isArray(saved.authors) ? saved.authors.filter((a) => typeof a === "string") : fallback.authors,
      showRemotes: typeof saved.showRemotes === "boolean" ? saved.showRemotes : fallback.showRemotes,
      showTags: typeof saved.showTags === "boolean" ? saved.showTags : fallback.showTags,
      showStashes: typeof saved.showStashes === "boolean" ? saved.showStashes : fallback.showStashes,
    };
  } catch {
    // A private window with storage blocked, or a value from an older
    // version that no longer parses: the defaults are always a valid answer.
    return fallback;
  }
}

export function saveFilter(root: string, filter: GraphFilter): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + root, JSON.stringify(filter));
  } catch {
    // Storage is a convenience here, never a correctness requirement.
  }
}

// ---- Search ----

export interface SearchableCommit {
  hash: string;
  author: string;
  subject: string;
  refs: { name: string }[];
}

// The same matcher behind both the highlight and the Filter toggle, so what
// the two show can never disagree. A hash matches by prefix (that is how
// anyone types one); everything else matches anywhere in the text.
export function matchesQuery(commit: SearchableCommit, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (commit.hash.toLowerCase().startsWith(q)) return true;
  if (commit.subject.toLowerCase().includes(q)) return true;
  if (commit.author.toLowerCase().includes(q)) return true;
  return commit.refs.some((ref) => ref.name.toLowerCase().includes(q));
}

export function matchIndexes(commits: SearchableCommit[], query: string): number[] {
  if (!query.trim()) return [];
  const out: number[] = [];
  for (let i = 0; i < commits.length; i++) {
    if (matchesQuery(commits[i], query)) out.push(i);
  }
  return out;
}
