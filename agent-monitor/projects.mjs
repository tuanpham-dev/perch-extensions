// Which project an agent window belongs to: the repository its folder is in,
// and the branch of the worktree it actually sits in.
//
// The board groups and filters by project, and a project is the REPOSITORY,
// never the checkout folder - an agent in perch/.worktrees/feature-x belongs
// to "perch" and shows "feature-x", the same grouping the PROJECTS tree uses
// (core's client/src/lib/projects.ts, which an extension cannot import).
// host.worktrees.list() answers both halves in one git call: `repo` is the
// main worktree's path whichever worktree you ask from, and the listing names
// every worktree's branch.
//
// A folder outside any repository is not an error: it becomes its own
// project, named after itself, which is what a session started in a plain
// directory should look like on the board.
import { homedir } from "node:os";
import path from "node:path";

// A repository's worktree set changes when someone adds or removes one -
// rare, and never mid-poll - so the answer is worth holding onto. Keyed by
// the resolved folder rather than by repo: the question asked is always
// "which project is THIS window in".
const CACHE_TTL_MS = 30_000;
const cache = new Map();

// Session and window paths arrive `~`-shortened (the client displays them
// that way), and every comparison below is a path prefix test, so they have
// to be expanded before anything is matched against git's absolute paths.
export function expandHome(p) {
  if (!p) return "";
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

// The deepest worktree containing `dir`. Worktrees nest inside the repo by
// default (.worktrees/<branch>), so the MAIN worktree is a prefix of every
// linked one and the longest match is the only correct answer.
export function pickWorktree(worktrees, dir) {
  let best = null;
  for (const wt of worktrees ?? []) {
    if (!wt?.path) continue;
    const under = dir === wt.path || dir.startsWith(wt.path.endsWith("/") ? wt.path : `${wt.path}/`);
    if (!under) continue;
    if (!best || wt.path.length > best.path.length) best = wt;
  }
  return best;
}

async function resolveUncached(host, dir) {
  let listing = null;
  try {
    // Optional-called: a core without host.worktrees still gets a board,
    // with every session's own folder as its project.
    listing = (await host.worktrees?.list(dir)) ?? null;
  } catch {
    // Not a repository, or git is unhappy - the fallback below is the same
    // answer either way.
    listing = null;
  }
  if (!listing?.repo) {
    return { repo: dir, project: path.basename(dir), branch: null, linked: false };
  }
  const wt = pickWorktree(listing.worktrees, dir);
  return {
    repo: listing.repo,
    project: path.basename(listing.repo),
    // A detached head has no branch; the card then shows the project alone.
    branch: wt?.detached ? null : (wt?.branch ?? null),
    // Whether this window sits in a linked worktree rather than the
    // repository's own checkout - what the card highlights.
    linked: wt ? wt.main !== true : false,
  };
}

export async function resolveProject(host, cwd) {
  const dir = expandHome(cwd);
  if (!dir) return { repo: "", project: "", branch: null, linked: false };
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await resolveUncached(host, dir);
  cache.set(dir, { at: Date.now(), value });
  return value;
}

export function clearProjectCache() {
  cache.clear();
}
