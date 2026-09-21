// jira.projectMap, as an editable list rather than a JSON string the user
// types. The setting stays exactly what server.js's resolveProjectKey reads -
// an object of repo path to project key - and this module is only the shape
// the pane's picker and the Settings table work in.
export interface ProjectMapEntry {
  repo: string;
  key: string;
}

export interface ParsedProjectMap {
  entries: ProjectMapEntry[];
  // True when the stored value could not be read as a mapping at all. The UI
  // says so and refuses to write, rather than silently replacing text the
  // user typed by hand with an empty object.
  malformed: boolean;
}

// A trailing slash is stripped the way resolveProjectKey compares paths, so
// "/works/acme/" and "/works/acme" are one entry rather than two that
// disagree about the same repo.
export function normalizeRepo(repo: string): string {
  return repo.replace(/\/+$/, "");
}

export function parseProjectMap(raw: unknown): ParsedProjectMap {
  if (raw === undefined || raw === null) return { entries: [], malformed: false };
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    // An empty setting is the default, not a mistake.
    if (!raw.trim()) return { entries: [], malformed: false };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { entries: [], malformed: true };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { entries: [], malformed: true };

  const entries: ProjectMapEntry[] = [];
  for (const [repo, key] of Object.entries(parsed as Record<string, unknown>)) {
    // One bad value condemns the whole setting rather than being dropped:
    // quietly discarding a line the user wrote is worse than declining to
    // touch the value until they fix it.
    if (typeof key !== "string") return { entries: [], malformed: true };
    entries.push({ repo: normalizeRepo(repo), key: key.trim().toUpperCase() });
  }
  return { entries, malformed: false };
}

// Replaced in place when the repo is already mapped, rather than removed and
// appended, so re-picking a project doesn't shuffle the Settings table under
// the pointer.
export function upsertProjectMap(
  entries: readonly ProjectMapEntry[],
  repo: string,
  key: string,
): ProjectMapEntry[] {
  const target = normalizeRepo(repo);
  const value = key.trim().toUpperCase();
  if (entries.some((entry) => entry.repo === target)) {
    return entries.map((entry) => (entry.repo === target ? { repo: target, key: value } : entry));
  }
  return [...entries, { repo: target, key: value }];
}

export function removeProjectMap(entries: readonly ProjectMapEntry[], repo: string): ProjectMapEntry[] {
  const target = normalizeRepo(repo);
  return entries.filter((entry) => entry.repo !== target);
}

export function projectKeyFor(entries: readonly ProjectMapEntry[], repo: string | null): string | null {
  if (!repo) return null;
  const target = normalizeRepo(repo);
  return entries.find((entry) => entry.repo === target)?.key ?? null;
}

export function serializeProjectMap(entries: readonly ProjectMapEntry[]): string {
  return JSON.stringify(Object.fromEntries(entries.map((entry) => [entry.repo, entry.key])));
}
