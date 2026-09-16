// github server hook: PR/issue listing and "Start work" worktree creation,
// all driven through the `gh` CLI (execFile, never a shell string — branch
// names, titles, and numbers are external data). No credentials of its own:
// authorization is whatever `gh auth login` already set up on this machine.
//
// The worktree-creation helpers (repoRoot/gitCommonDir/ensureExcluded/
// resolveLocation) reimplement what core does in server/src/gitWorktrees.ts
// (in the main perch repo), in step with the jira extension's copy - this
// registry repo can't import core or across extensions, so they're copied
// with this comment naming the source rather than silently duplicated.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GH_TIMEOUT = 15000;
const GIT_TIMEOUT = 15000;
const FETCH_TIMEOUT = 60000; // a cold `git fetch` on a large repo outlasts 15s

function run(cmd, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

const gh = (args, cwd) => run("gh", args, cwd, GH_TIMEOUT);
const git = (args, cwd, timeout = GIT_TIMEOUT) => run("git", args, cwd, timeout);

async function ghAuthed() {
  try {
    await gh(["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

async function repoNameWithOwner(cwd) {
  try {
    const out = await gh(["repo", "view", "--json", "nameWithOwner"], cwd);
    return JSON.parse(out).nameWithOwner ?? null;
  } catch {
    return null;
  }
}

// ---- Worktree-creation helpers (see this file's header) ----

// The MAIN worktree, not `--show-toplevel`. --show-toplevel returns
// whichever worktree cwd happens to be in, so starting work on a second
// PR/issue from inside the first one's session would create the new
// worktree *under* that one - and nest one level deeper every time after.
// `git worktree list --porcelain` always emits the main worktree first.
// Mirrors core's mainRepoRoot (server/src/gitWorktrees.ts in the main
// perch repo) and the jira extension's copy.
async function repoRoot(cwd) {
  let inside;
  try {
    inside = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    return null;
  }
  if (!inside) return null;
  try {
    const out = await git(["worktree", "list", "--porcelain"], inside);
    const first = out.split("\n").find((line) => line.startsWith("worktree "));
    if (first) return first.slice("worktree ".length).trim();
  } catch {
    // Unusual layout - the containing worktree is still a usable answer.
  }
  return inside;
}

async function gitCommonDir(cwd) {
  const raw = (await git(["rev-parse", "--git-common-dir"], cwd)).trim();
  return path.resolve(cwd, raw);
}

function branchSlug(branch) {
  return branch.replace(/[/\\]/g, "-");
}

function resolveLocation(template, repo, branch) {
  const filled = template.replaceAll("{repo}", repo).replaceAll("{branch}", branchSlug(branch));
  return path.resolve(repo, filled);
}

async function ensureExcluded(repo, target) {
  const rel = path.relative(repo, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  const top = rel.split(path.sep)[0];
  const pattern = rel === top ? `/${top}` : `/${top}/`;
  let excludeFile;
  try {
    excludeFile = path.join(await gitCommonDir(repo), "info", "exclude");
  } catch {
    return;
  }
  let current = "";
  try {
    current = fs.readFileSync(excludeFile, "utf8");
  } catch {
    // No info/exclude yet (or unreadable) — created below.
  }
  if (current.split("\n").some((line) => line.trim() === pattern)) return;
  try {
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(excludeFile, `${prefix}${pattern}\n`);
  } catch {
    // Best-effort: a read-only .git shouldn't block creating the worktree.
  }
}

export function activate({ router, getSettings }) {
  // authed:false, never a 500 — the panel's own "not set up" state reads
  // this, and a missing/unauthed `gh` is the expected common case, not an
  // error.
  router.get("/status", async (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    if (!cwd || !path.isAbsolute(cwd)) {
      res.status(400).json({ error: "cwd must be an absolute path" });
      return;
    }
    const authed = await ghAuthed();
    if (!authed) {
      res.json({ authed: false, repo: null });
      return;
    }
    res.json({ authed: true, repo: await repoNameWithOwner(cwd) });
  });

  router.get("/prs", async (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    if (!cwd || !path.isAbsolute(cwd)) {
      res.status(400).json({ error: "cwd must be an absolute path" });
      return;
    }
    try {
      const out = await gh(
        ["pr", "list", "--json", "number,title,author,headRefName,updatedAt,isDraft,url", "--limit", "30"],
        cwd,
      );
      res.json({ prs: JSON.parse(out) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/issues", async (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    if (!cwd || !path.isAbsolute(cwd)) {
      res.status(400).json({ error: "cwd must be an absolute path" });
      return;
    }
    try {
      const out = await gh(["issue", "list", "--json", "number,title,author,updatedAt,url", "--limit", "30"], cwd);
      res.json({ issues: JSON.parse(out) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/issue", async (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    const number = typeof req.query.number === "string" ? req.query.number : "";
    if (!cwd || !path.isAbsolute(cwd) || !number) {
      res.status(400).json({ error: "cwd (absolute path) and number are required" });
      return;
    }
    try {
      const out = await gh(["issue", "view", number, "--json", "number,title,author,updatedAt,url,body"], cwd);
      res.json(JSON.parse(out));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The repo's default branch, so an issue worktree starts from it rather than
  // from whatever happened to be checked out. origin/HEAD is often simply
  // absent (a --depth clone, or an origin added by hand), so this falls back
  // through `git remote show` to the current HEAD, reporting which it used.
  // Same as the sibling jira extension's defaultBranch.
  async function defaultBranch(repo) {
    try {
      const ref = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo)).trim();
      if (ref) return { base: ref, note: null };
    } catch {
      // Fall through - not set locally.
    }
    try {
      const out = await git(["remote", "show", "origin"], repo, FETCH_TIMEOUT);
      const match = out.match(/HEAD branch:\s*(\S+)/);
      if (match && match[1] !== "(unknown)") return { base: `origin/${match[1]}`, note: null };
    } catch {
      // No origin, or it is unreachable.
    }
    return {
      base: null,
      note: "Could not determine the default branch (no origin/HEAD) - branched from the current HEAD instead. `git remote set-head origin -a` fixes this.",
    };
  }

  async function localBranchExists(repo, name) {
    try {
      await git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], repo);
      return true;
    } catch {
      return false;
    }
  }

  // Checks out a PR's head into a local branch for a worktree. Fetched into
  // FETCH_HEAD rather than straight into the branch (`pull/<n>/head:<branch>`):
  // that form fails outright once the branch exists and the PR was
  // force-pushed, or the branch carries local commits - i.e. on the second
  // "Start work" for the same PR. An existing branch is fast-forwarded when
  // that loses nothing, and otherwise reused as is, with a note, so commits
  // made on it are never discarded silently.
  async function addPrWorktree(repo, target, name, number) {
    await git(["fetch", "origin", `pull/${number}/head`], repo, FETCH_TIMEOUT);
    const head = (await git(["rev-parse", "FETCH_HEAD"], repo)).trim();
    if (!(await localBranchExists(repo, name))) {
      await git(["worktree", "add", "-b", name, target, head], repo);
      return null;
    }
    let note = null;
    let fastForward = false;
    try {
      await git(["merge-base", "--is-ancestor", name, head], repo);
      fastForward = true;
    } catch {
      note = `Branch ${name} already existed and has diverged from the PR head (local commits, or the PR was force-pushed) - reused it as is. \`git reset --hard ${head.slice(0, 12)}\` in the worktree takes the PR's version.`;
    }
    // Fails with git's own "used by worktree at ..." message when the branch
    // is checked out elsewhere, which is the right answer to surface.
    if (fastForward) await git(["branch", "-f", name, head], repo);
    await git(["worktree", "add", target, name], repo);
    return note;
  }

  // Creates a worktree for an issue (new branch off the default branch) or a
  // PR (fetches its head ref by number, per GitHub's refs/pull/<n>/head
  // convention, then checks that out - see addPrWorktree) — the session
  // itself is created client-side via ctx.app.openSessionWindow, same split of
  // duties as the worktrees extension. `note` in the response says when the
  // result isn't what the user would assume (a fallback base, a reused branch).
  router.post("/worktree", async (req, res) => {
    const { cwd, branch, kind, number } = req.body ?? {};
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || typeof branch !== "string" || !branch.trim()) {
      res.status(400).json({ error: "cwd (absolute path) and branch are required" });
      return;
    }
    const repo = await repoRoot(cwd);
    if (!repo) {
      res.status(400).json({ error: `${cwd} is not inside a git repository` });
      return;
    }
    const settings = await getSettings();
    const template =
      typeof settings["github.worktreeLocation"] === "string" && settings["github.worktreeLocation"].trim()
        ? settings["github.worktreeLocation"].trim()
        : "{repo}/.worktrees/{branch}";
    const name = branch.trim();
    const target = resolveLocation(template, repo, name);
    if (fs.existsSync(target)) {
      res.status(409).json({ error: `${target} already exists` });
      return;
    }
    if (kind === "pr" && !Number.isInteger(number)) {
      res.status(400).json({ error: "number (integer) is required for kind=pr" });
      return;
    }

    let base = null;
    let note = null;
    if (kind !== "pr") {
      ({ base, note } = await defaultBranch(repo));
      if (base) {
        try {
          await git(["fetch", "origin"], repo, FETCH_TIMEOUT);
        } catch (err) {
          // Branching off a stale base silently is worse than saying so.
          res.status(502).json({ error: `git fetch origin failed: ${err.message}` });
          return;
        }
      }
    }

    await ensureExcluded(repo, target);
    try {
      if (kind === "pr") {
        note = await addPrWorktree(repo, target, name, number);
      } else {
        const args = ["worktree", "add", "-b", name, target];
        if (base) args.push(base);
        await git(args, repo);
      }
      res.json({ path: target, branch: name, note });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
