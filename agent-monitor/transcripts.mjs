// Where Claude Code keeps a folder's transcripts: one project dir per working
// directory under ~/.claude/projects, named by Claude Code's slug of the path.
//
// The slug replaces every character that isn't an ASCII letter or digit with
// "-", so "/home/x/my_app proj" lives in "-home-x-my-app-proj". This file used
// to replace only "/" and ".", which found nothing for a folder with a space,
// an underscore or any other punctuation in its path, and the window fell back
// to idle. The older rule is still tried second, as core's own reader does
// (server/src/agentSessionFormats/claudeJsonl.ts, which an extension cannot
// import), in case a Claude Code version ever wrote that shape.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { expandHome } from "./projects.mjs";

export const CLAUDE_PROJECTS_DIR = path.join(homedir(), ".claude", "projects");

// Candidate project dirs for a folder, Claude Code's own rule first.
// Duplicates collapse. `cwd` may be `~`-shortened, as session paths arrive.
export function claudeProjectDirs(root, cwd) {
  const dir = expandHome(cwd);
  if (!dir) return [];
  const slugs = new Set([dir.replace(/[^a-zA-Z0-9]/g, "-"), dir.replace(/[\\/:.]/g, "-")]);
  return [...slugs].map((slug) => path.join(root, slug));
}

// One session's transcript, from whichever candidate dir holds it.
export async function sessionTranscript(root, cwd, sessionId) {
  for (const dir of claudeProjectDirs(root, cwd)) {
    try {
      const s = await stat(path.join(dir, `${sessionId}.jsonl`));
      return { id: sessionId, mtimeMs: s.mtimeMs, file: path.join(dir, `${sessionId}.jsonl`) };
    } catch {
      // Not in this one.
    }
  }
  return null;
}

// The most recently written transcript for a folder, across every candidate
// dir. Null when there is none.
export async function mostRecentTranscript(root, cwd) {
  let best = null;
  for (const dir of claudeProjectDirs(root, cwd)) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      try {
        const s = await stat(file);
        if (!best || s.mtimeMs > best.mtimeMs) best = { id: name.slice(0, -".jsonl".length), mtimeMs: s.mtimeMs, file };
      } catch {
        // Skip - vanished mid-scan.
      }
    }
  }
  return best;
}
