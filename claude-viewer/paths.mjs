// File-link resolution for the chat: which path-shaped strings in a message
// or tool output are real files. The same lookup order as core's terminal
// links (server/src/pathLinks.ts resolveLinkPath), so a path that links in
// the terminal links here too: absolute as is, else the session's cwd, then
// that cwd's git top-level, then both again with a git diff "a/" or "b/"
// prefix removed. Only regular files come back.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAX_PATHS = 200;

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function isFile(p) {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

// The nearest directory at or above `dir` holding a .git entry (a directory,
// or the file a worktree or submodule has), found without running git.
async function gitRoot(dir) {
  for (let current = dir; ; ) {
    try {
      await fs.access(path.join(current, ".git"));
      return current;
    } catch {
      // Keep climbing.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function resolvePaths(paths, cwd) {
  // A relative cwd would resolve against the server's own directory.
  if (cwd && !path.isAbsolute(cwd)) cwd = "";
  const root = cwd ? await gitRoot(cwd) : null;
  const bases = cwd ? (root && root !== cwd ? [cwd, root] : [cwd]) : [];
  return Promise.all(
    paths.map(async (raw) => {
      if (typeof raw !== "string" || !raw) return null;
      const expanded = expandHome(raw);
      // normalize: a "file:///x" URL's detected path is "///x".
      if (path.isAbsolute(expanded)) return (await isFile(expanded)) ? path.normalize(expanded) : null;
      const rels = /^[ab]\//.test(expanded) ? [expanded, expanded.slice(2)] : [expanded];
      for (const rel of rels) {
        for (const base of bases) {
          const abs = path.join(base, rel);
          if (await isFile(abs)) return abs;
        }
      }
      return null;
    }),
  );
}
