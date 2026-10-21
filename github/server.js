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
//
// The pure parts - telling gh's failures apart, matching an existing
// worktree/session, planning where a PR's head is fetched from, building the
// agent's brief - live in ghModel.mjs, where src/ghModel.test.ts covers them.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildIssueBrief,
  buildPrBrief,
  classifyGhError,
  findSessionFor,
  findWorktreeFor,
  firstLine,
  listArgs,
  pageOf,
  parseRemotes,
  parseWorktreeList,
  prFetchPlan,
} from "./ghModel.mjs";

const GH_TIMEOUT = 15000;
const GIT_TIMEOUT = 15000;
const FETCH_TIMEOUT = 60000; // a cold `git fetch` on a large repo outlasts 15s

// Rejects with execFile's exit `code` ("ENOENT" when the program is missing),
// `killed` (the timeout fired) and the raw stderr carried on the error, so a
// gh failure can be told apart afterwards - see classifyGhError.
function run(cmd, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(
          Object.assign(new Error(stderr.trim() || err.message), {
            code: err.code,
            killed: err.killed === true,
            stderr: String(stderr ?? ""),
          }),
        );
      } else resolve(stdout);
    });
  });
}

const gh = (args, cwd) => run("gh", args, cwd, GH_TIMEOUT);
const git = (args, cwd, timeout = GIT_TIMEOUT) => run("git", args, cwd, timeout);

// A gh failure as a response the panel can name: `kind` is one of
// gh-missing / network / auth / not-github / gh, `error` says it in words.
function sendGhError(res, err) {
  const problem = classifyGhError(err);
  const status = problem.kind === "gh-missing" ? 501 : problem.kind === "gh" ? 500 : 502;
  res.status(status).json({ error: problem.message, kind: problem.kind, detail: problem.detail });
}

// Same convention core uses for the paths it hands the client, and the one
// session paths come back from host.sessions.list() in.
function shortenHome(abs) {
  const home = os.homedir();
  if (!home) return abs;
  if (abs === home) return "~";
  return abs.startsWith(`${home}/`) ? `~${abs.slice(home.length)}` : abs;
}

function requireCwd(req, res) {
  const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
  if (!cwd || !path.isAbsolute(cwd)) {
    res.status(400).json({ error: "cwd must be an absolute path" });
    return null;
  }
  return cwd;
}

function parseNumber(value) {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const PR_DETAIL_FIELDS =
  "number,title,author,url,body,state,headRefName,baseRefName,headRepository,headRepositoryOwner,isCrossRepository";

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


async function listWorktrees(repo) {
  try {
    return parseWorktreeList(await git(["worktree", "list", "--porcelain"], repo));
  } catch {
    return [];
  }
}

// The terminal sessions open right now, or none on a Perch too old to have
// host.sessions - "Start work" then falls back to opening by name.
async function listSessions(host) {
  if (typeof host?.sessions?.list !== "function") return [];
  try {
    return await host.sessions.list();
  } catch {
    return [];
  }
}

// What a PR or issue already has: its worktree and, when one is open, the
// session on it. Both null when "Start work" has nothing to reuse.
async function existingFor(repo, host, match) {
  const worktree = findWorktreeFor(await listWorktrees(repo), match);
  if (!worktree) return { worktree: null, session: null };
  const session = findSessionFor(await listSessions(host), {
    branch: worktree.branch,
    displayPath: shortenHome(worktree.path),
  });
  return { worktree: { path: worktree.path, branch: worktree.branch }, session: session ? session.name : null };
}

export function activate({ router, getSettings, host }) {
  // Never a 500 for the expected cases: gh missing, signed out, offline, or
  // a folder that isn't a GitHub repository all come back as `problem`, so
  // the panel can say which one it is instead of showing gh's raw text.
  router.get("/status", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    try {
      const out = await gh(["repo", "view", "--json", "nameWithOwner"], cwd);
      res.json({ authed: true, repo: JSON.parse(out).nameWithOwner ?? null, problem: null });
    } catch (err) {
      const problem = classifyGhError(err);
      res.json({ authed: problem.kind !== "auth" && problem.kind !== "gh-missing", repo: null, problem });
    }
  });

  // ?state=open|closed|merged|all &mine=1 &limit=<n>. `hasMore` says whether
  // a longer list exists - see listArgs.
  async function listRoute(kind, req, res) {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const { args, limit } = listArgs(kind, {
      state: req.query.state,
      mine: req.query.mine === "1" || req.query.mine === "true",
      limit: req.query.limit,
    });
    try {
      const { rows, hasMore } = pageOf(JSON.parse(await gh(args, cwd)), limit);
      res.json(kind === "pr" ? { prs: rows, hasMore } : { issues: rows, hasMore });
    } catch (err) {
      sendGhError(res, err);
    }
  }

  router.get("/prs", (req, res) => listRoute("pr", req, res));
  router.get("/issues", (req, res) => listRoute("issue", req, res));

  router.get("/issue", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const number = parseNumber(req.query.number);
    if (!number) {
      res.status(400).json({ error: "number is required" });
      return;
    }
    try {
      const out = await gh(["issue", "view", String(number), "--json", "number,title,author,updatedAt,url,body"], cwd);
      res.json(JSON.parse(out));
    } catch (err) {
      sendGhError(res, err);
    }
  });

  // The text "Start work" hands the agent: the issue's or PR's title, link
  // and body (for a PR also its branches), built in ghModel.mjs.
  router.get("/brief", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const number = parseNumber(req.query.number);
    const kind = req.query.kind === "pr" ? "pr" : "issue";
    if (!number) {
      res.status(400).json({ error: "number is required" });
      return;
    }
    try {
      if (kind === "pr") {
        const pr = JSON.parse(await gh(["pr", "view", String(number), "--json", PR_DETAIL_FIELDS], cwd));
        res.json({ text: buildPrBrief(pr) });
      } else {
        const issue = JSON.parse(
          await gh(["issue", "view", String(number), "--json", "number,title,author,url,body"], cwd),
        );
        res.json({ text: buildIssueBrief(issue) });
      }
    } catch (err) {
      sendGhError(res, err);
    }
  });

  // Whether a PR or issue already has a worktree, and a session open on it,
  // asked before "Start work" offers its agent picker: there is nothing to
  // pick when the answer is to switch to the session already there. The
  // PR's head branch and fork flag come from the panel's own list row - they
  // only narrow which local branch counts as the PR's, see findWorktreeFor.
  router.get("/existing", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const number = parseNumber(req.query.number);
    if (!number) {
      res.status(400).json({ error: "number is required" });
      return;
    }
    const repo = await repoRoot(cwd);
    if (!repo) {
      res.json({ worktree: null, session: null });
      return;
    }
    res.json(
      await existingFor(repo, host, {
        kind: req.query.kind === "pr" ? "pr" : "issue",
        number,
        headRefName: typeof req.query.head === "string" ? req.query.head : "",
        isCrossRepository: req.query.cross === "1",
      }),
    );
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

  // gh's own clone protocol for this host, so a fork fetched by URL uses the
  // credentials gh set git up with. https when gh has no opinion.
  async function gitProtocol(repo, hostName) {
    try {
      const out = (await gh(["config", "get", "git_protocol", "-h", hostName], repo)).trim();
      return out === "ssh" ? "ssh" : "https";
    } catch {
      return "https";
    }
  }

  // Fetches a PR's head commit, trying each source prFetchPlan lists in turn
  // (the head branch from the repository it lives in - a fork's, for a fork
  // PR - then refs/pull/<n>/head on the base repository). Returns the commit
  // and the source that worked; throws with every source's reason when none
  // did.
  async function fetchPrHead(repo, pr) {
    let remotes = [];
    try {
      remotes = parseRemotes(await git(["remote", "-v"], repo));
    } catch {
      // No remotes: every source is fetched by URL.
    }
    let hostName = "github.com";
    try {
      hostName = new URL(pr.url).hostname;
    } catch {
      // prFetchPlan below finds no base repository and says so.
    }
    const plan = prFetchPlan(pr, remotes, await gitProtocol(repo, hostName));
    if (plan.length === 0) throw new Error(`PR #${pr.number} has no usable URL to fetch from`);
    const failures = [];
    for (const step of plan) {
      try {
        await git(["fetch", "--no-tags", step.source, step.ref], repo, FETCH_TIMEOUT);
        return { head: (await git(["rev-parse", "FETCH_HEAD"], repo)).trim(), step };
      } catch (err) {
        failures.push(`${step.label}: ${firstLine(err.message) || "fetch failed"}`);
      }
    }
    throw new Error(`Could not fetch PR #${pr.number}'s head. ${failures.join("; ")}`);
  }

  // Checks out a PR's head into a local branch for a worktree. Fetched into
  // FETCH_HEAD rather than straight into the branch (`<ref>:<branch>`): that
  // form fails outright once the branch exists and the PR was force-pushed,
  // or the branch carries local commits - i.e. on the second "Start work"
  // for the same PR. An existing branch is fast-forwarded when that loses
  // nothing, and otherwise reused as is, with a note, so commits made on it
  // are never discarded silently. A new branch tracks the PR's head branch
  // where it came from, as `gh pr checkout` sets it up, so `git pull` follows
  // the PR.
  async function addPrWorktree(repo, target, name, pr) {
    const { head, step } = await fetchPrHead(repo, pr);
    if (!(await localBranchExists(repo, name))) {
      await git(["worktree", "add", "-b", name, target, head], repo);
      if (step.upstream) {
        try {
          await git(["config", `branch.${name}.remote`, step.upstream.remote], repo);
          await git(["config", `branch.${name}.merge`, step.upstream.merge], repo);
        } catch {
          // Tracking is a convenience; the worktree is already there.
        }
      }
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

  // Creates the worktree for an issue (new branch off the default branch) or
  // a PR (its head fetched from wherever it lives - see fetchPrHead), unless
  // it already has one: then that worktree comes back with `reused: true`,
  // plus `session` when a session is already open on it, and nothing is
  // created. The session itself is created client-side via
  // ctx.app.openSessionWindow, same split of duties as the worktrees
  // extension. `note` says when the result isn't what the user would assume
  // (a fallback base, a reused branch).
  router.post("/worktree", async (req, res) => {
    const { cwd, branch, kind } = req.body ?? {};
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || typeof branch !== "string" || !branch.trim()) {
      res.status(400).json({ error: "cwd (absolute path) and branch are required" });
      return;
    }
    const number = parseNumber(req.body?.number);
    if (kind === "pr" && !number) {
      res.status(400).json({ error: "number (integer) is required for kind=pr" });
      return;
    }
    const repo = await repoRoot(cwd);
    if (!repo) {
      res.status(400).json({ error: `${cwd} is not inside a git repository` });
      return;
    }

    let pr = null;
    if (kind === "pr") {
      try {
        pr = JSON.parse(await gh(["pr", "view", String(number), "--json", PR_DETAIL_FIELDS], repo));
      } catch (err) {
        sendGhError(res, err);
        return;
      }
    }

    if (number) {
      const existing = await existingFor(repo, host, {
        kind: kind === "pr" ? "pr" : "issue",
        number,
        headRefName: pr?.headRefName,
        isCrossRepository: pr?.isCrossRepository === true,
      });
      if (existing.worktree) {
        res.json({ ...existing.worktree, reused: true, session: existing.session, note: null });
        return;
      }
    }

    const settings = await getSettings();
    const template =
      typeof settings["github.worktreeLocation"] === "string" && settings["github.worktreeLocation"].trim()
        ? settings["github.worktreeLocation"].trim()
        : "{repo}/.worktrees/{branch}";
    const name = branch.trim();
    const target = resolveLocation(template, repo, name);
    if (fs.existsSync(target)) {
      res.status(409).json({ error: `${target} already exists and is not a worktree for this ${kind === "pr" ? "PR" : "issue"}` });
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
        note = await addPrWorktree(repo, target, name, pr);
      } else {
        const args = ["worktree", "add", "-b", name, target];
        if (base) args.push(base);
        await git(args, repo);
      }
      res.json({ path: target, branch: name, reused: false, session: null, note });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
