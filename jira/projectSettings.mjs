// Per-project settings: the same jira.* keys, overridden for one Jira project.
//
// Most of what the extension is told is really about one project - which
// branch is production, what the QA status is called, who takes handed-off
// tickets, which skills run - and a second project wants different answers.
// jira.projectSettings holds them, as JSON keyed by project key:
//
//   { "CAP": { "jira.productionBranch": "main", "jira.qaStatus": "QA" } }
//
// A key present in a project's block wins over the global value; a key absent
// from it inherits. The site, the account, and the four settings that decide
// WHICH project a repository belongs to cannot be per-project: they are what
// the lookup runs on.
//
// Pure, and shared by the server, the batch runner and the client, so the
// three agree on what "the setting for this project" means.

const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;

export const GLOBAL_ONLY = new Set([
  "jira.siteUrl",
  "jira.email",
  "jira.projectKey",
  "jira.projectKeyFile",
  "jira.projectKeyEnv",
  "jira.projectMap",
  "jira.projectSettings",
]);

export function isOverridable(key) {
  return typeof key === "string" && key.startsWith("jira.") && !GLOBAL_ONLY.has(key);
}

// The setting's raw value as a map of project key -> overrides. Malformed
// JSON, or JSON of the wrong shape, reads as empty with `malformed` set, so
// an editor can refuse to write over text it could not read. Project keys are
// upper-cased on the way in (a hand-typed "cap" means CAP); blocks that are
// not objects, and keys that are not overridable, are dropped.
export function parseProjectSettings(raw) {
  const empty = { projects: {}, malformed: false };
  if (raw === undefined || raw === null || raw === "") return empty;
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { projects: {}, malformed: true };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { projects: {}, malformed: true };
  const projects = {};
  for (const [name, block] of Object.entries(parsed)) {
    const key = String(name).trim().toUpperCase();
    if (!PROJECT_KEY.test(key) || !block || typeof block !== "object" || Array.isArray(block)) continue;
    const overrides = {};
    for (const [setting, value] of Object.entries(block)) {
      if (isOverridable(setting) && value !== undefined && value !== null) overrides[setting] = value;
    }
    projects[key] = { ...(projects[key] ?? {}), ...overrides };
  }
  return { projects, malformed: false };
}

// This project's overrides alone. Empty for no project, or a project with
// none, or a setting that could not be read: the global values then apply,
// which is what "no override" means anyway.
export function overridesFor(raw, projectKey) {
  if (typeof projectKey !== "string" || !projectKey) return {};
  const key = projectKey.trim().toUpperCase();
  return parseProjectSettings(raw).projects[key] ?? {};
}

// The whole settings object as this project sees it. Returns a new object;
// the one passed in is what every other project still reads.
export function settingsForProject(settings, projectKey) {
  const base = settings && typeof settings === "object" ? settings : {};
  const overrides = overridesFor(base["jira.projectSettings"], projectKey);
  if (Object.keys(overrides).length === 0) return base;
  return { ...base, ...overrides };
}

// A new value for the setting with one override changed. `value` undefined
// (or an empty string) removes the override, so a cleared field in the editor
// goes back to inheriting rather than pinning "" for the project. A project
// left with no overrides disappears from the JSON altogether.
export function setProjectOverride(raw, projectKey, setting, value) {
  const { projects } = parseProjectSettings(raw);
  const key = String(projectKey ?? "").trim().toUpperCase();
  if (!PROJECT_KEY.test(key) || !isOverridable(setting)) return serializeProjectSettings(projects);
  const block = { ...(projects[key] ?? {}) };
  if (value === undefined || value === null || value === "") delete block[setting];
  else block[setting] = value;
  const next = { ...projects };
  if (Object.keys(block).length === 0) delete next[key];
  else next[key] = block;
  return serializeProjectSettings(next);
}

export function removeProjectOverrides(raw, projectKey) {
  const { projects } = parseProjectSettings(raw);
  const next = { ...projects };
  delete next[String(projectKey ?? "").trim().toUpperCase()];
  return serializeProjectSettings(next);
}

// Stable key order so the JSON field reads the same after every edit.
export function serializeProjectSettings(projects) {
  const ordered = {};
  for (const key of Object.keys(projects).sort()) {
    const block = {};
    for (const setting of Object.keys(projects[key]).sort()) block[setting] = projects[key][setting];
    ordered[key] = block;
  }
  return JSON.stringify(ordered, null, 2);
}
