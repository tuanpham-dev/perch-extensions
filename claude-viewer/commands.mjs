// Composer autocomplete data: slash commands and skills from disk, and file
// search under the session's directory. Ported from the claude-web
// extension's server.js unchanged apart from the exports.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME_COMMANDS_DIR = path.join(os.homedir(), ".claude", "commands");
const HOME_SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");
// Best-effort — not read from the SDK (no session here); may drift as
// Claude Code ships new/renamed built-ins. Autocomplete suggestions only,
// never validated against what the TUI actually supports.
const BUILTIN_COMMANDS = [
  { name: "clear", description: "Start a new session with empty context" },
  { name: "compact", description: "Free up context by summarizing the conversation so far" },
  { name: "context", description: "Visualize current context usage as a colored grid" },
  { name: "model", description: "Switch the active model" },
  { name: "help", description: "Show help" },
  { name: "resume", description: "Resume a previous session" },
  { name: "status", description: "Show session status" },
];

/** Minimal `key: value` reader between the first two `---` fence lines —
 * not real YAML (no multi-line/nested values), but frontmatter in this repo's
 * commands/skills is always flat scalars, quoted or not. */
export function parseFrontmatter(content) {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.indexOf("---", 1);
  if (end === -1) return {};
  const out = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/** `.md` files under `dir` (recursive) — command name is the relative path
 * minus `.md`, so a nested command shows its subfolder (e.g. "git/commit"). */
export async function listCommandFiles(dir) {
  const results = [];
  const walk = async (current, rel) => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), relPath);
      } else if (entry.name.endsWith(".md")) {
        const name = relPath.slice(0, -".md".length);
        let description = "";
        let argumentHint = "";
        try {
          const fm = parseFrontmatter(await fs.readFile(path.join(current, entry.name), "utf8"));
          description = fm.description ?? "";
          argumentHint = fm["argument-hint"] ?? "";
        } catch {
          // unreadable file — still list the name
        }
        results.push({ name, description, argumentHint });
      }
    }
  };
  await walk(dir, "");
  return results;
}

/** One entry per immediate subdirectory of `dir` containing a SKILL.md —
 * name/description from frontmatter, falling back to the directory name if
 * frontmatter has no `name`. */
export async function listSkills(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    try {
      const fm = parseFrontmatter(await fs.readFile(skillFile, "utf8"));
      results.push({
        name: fm.name || entry.name,
        description: fm.description ?? "",
        argumentHint: fm["argument-hint"] ?? "",
      });
    } catch {
      // no SKILL.md in this dir — not a skill, skip
    }
  }
  return results;
}

const FILE_SEARCH_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "__pycache__"]);

/** Ported from claude-web's server/src/dirs.ts searchFiles — same bounds. */
export async function searchProjectFiles(cwd, query, limit = 20) {
  const results = [];
  const needle = query.toLowerCase();
  let visited = 0;
  const walk = async (dir, rel, depth) => {
    if (results.length >= limit || visited > 4000 || depth > 6) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      visited++;
      if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!FILE_SEARCH_SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), relPath, depth + 1);
      } else if (needle === "" || relPath.toLowerCase().includes(needle)) {
        results.push(relPath);
      }
    }
  };
  await walk(cwd, "", 0);
  return results;
}

// The merged list the `/` dropdown shows: built-ins, then home and project
// commands and skills, later sources overriding earlier ones by name.
export async function listCommands(cwd) {
  const [homeCommands, homeSkills, projectCommands, projectSkills] = await Promise.all([
    listCommandFiles(HOME_COMMANDS_DIR),
    listSkills(HOME_SKILLS_DIR),
    cwd ? listCommandFiles(path.join(cwd, ".claude", "commands")) : [],
    cwd ? listSkills(path.join(cwd, ".claude", "skills")) : [],
  ]);
  const merged = new Map();
  for (const c of BUILTIN_COMMANDS) merged.set(c.name, { ...c, argumentHint: "", builtin: true });
  for (const c of [...homeCommands, ...homeSkills, ...projectCommands, ...projectSkills]) {
    merged.set(c.name, { ...c, builtin: false });
  }
  return [...merged.values()];
}
