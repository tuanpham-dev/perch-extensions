// Finding the skills a cluster's agent can be pointed at.
//
// A skill here is what Claude Code calls one: a directory holding a
// SKILL.md whose frontmatter gives it a name and a description. This module
// only ever LOCATES them - it never reads a skill's body, never validates it
// and never rewrites it. Whatever a chosen skill says is what the agent does;
// the only contract between the extension and a skill is the `jira-batch`
// verbs, which live in the brief (plans/jira-batch-executor-qa.spec.html, R16).
//
// Three places are searched, in this order, because that is the order of
// specificity: the user's own skills, then the repository's, then anywhere
// they have added by hand. A name that exists in two of them is not a
// conflict to resolve - both are listed, and the directory is the identity,
// so a picker can show "shopify-qa (yours)" beside "shopify-qa (this repo)".
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SKILL_FILE = "SKILL.md";

// Deliberately not a YAML parser. A skill's frontmatter is a handful of
// scalars, and the two fields wanted here are the two every skill has; a
// dependency for that would be a dependency in every packaged extension that
// ever wants to list skills. Anything this cannot read falls back to the
// folder name, which is still a usable label.
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ""));
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    // A continuation line of a folded scalar, or a nested key: skipped
    // rather than guessed at.
    if (!pair) continue;
    let value = pair[2].trim();
    if (
      (value.startsWith("'") && value.endsWith("'") && value.length > 1) ||
      (value.startsWith('"') && value.endsWith('"') && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[pair[1]] = value;
  }
  return out;
}

async function isDir(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function readSkill(dir, origin) {
  const file = path.join(dir, SKILL_FILE);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const front = parseFrontmatter(text);
  const folder = path.basename(dir);
  return {
    // The directory is the identity: two skills may share a name, and a
    // stored setting must keep pointing at the one that was chosen.
    id: dir,
    dir,
    name: front.name || folder,
    description: front.description || "",
    origin,
  };
}

// A path the user added may be a directory OF skills or a single skill. It is
// decided by looking, not by a trailing-slash convention nobody would guess.
async function fromExtraPath(entry) {
  const dir = path.resolve(entry);
  if (!(await isDir(dir))) return [];
  const own = await readSkill(dir, "added");
  if (own) return [own];
  return listDirOfSkills(dir, "added");
}

async function listDirOfSkills(dir, origin) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    // A symlinked skill directory is a real answer: isDirectory() is false
    // for one, which is exactly how a symlinked EXTENSION goes missing in
    // core's own discovery. Not repeating that here.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skill = await readSkill(path.join(dir, entry.name), origin);
    if (skill) found.push(skill);
  }
  return found;
}

// options:
//   home       the user's home directory (a parameter so tests need no HOME)
//   repo       the repository being worked on, or null
//   extraPaths directories from jira.skillPaths
export async function discoverSkills({ home = os.homedir(), repo = null, extraPaths = [] } = {}) {
  const found = [
    ...(await listDirOfSkills(path.join(home, ".claude", "skills"), "yours")),
    ...(repo ? await listDirOfSkills(path.join(repo, ".claude", "skills"), "this repo") : []),
  ];
  for (const entry of extraPaths) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    found.push(...(await fromExtraPath(entry.trim())));
  }
  // Same directory reached two ways (an extra path that repeats the user's
  // own) is one skill, listed under where it was first found.
  const byDir = new Map();
  for (const skill of found) {
    if (!byDir.has(skill.dir)) byDir.set(skill.dir, skill);
  }
  return [...byDir.values()];
}

export function parseSkillPaths(setting) {
  return String(setting ?? "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// What a slot resolves to. `setting` is whatever the user stored: a
// directory, a bare name, "" for the default or "none" to leave the slot
// empty. A stored value that no longer matches anything is NOT silently
// replaced by the default - it comes back as `missing`, so the panel can say
// so instead of quietly running something else.
export function resolveSlot(setting, discovered, fallbackName) {
  const wanted = String(setting ?? "").trim();
  if (wanted.toLowerCase() === "none") return { skill: null, missing: false, explicitNone: true };

  if (wanted) {
    const byDir = discovered.find((skill) => skill.dir === wanted || path.resolve(skill.dir) === path.resolve(wanted));
    if (byDir) return { skill: byDir, missing: false, explicitNone: false };
    const byName = discovered.find((skill) => skill.name === wanted);
    if (byName) return { skill: byName, missing: false, explicitNone: false };
    return { skill: null, missing: true, wanted, explicitNone: false };
  }

  const fallback = fallbackName ? discovered.find((skill) => skill.name === fallbackName) : null;
  return { skill: fallback ?? null, missing: false, explicitNone: false };
}
