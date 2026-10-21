// Pure helpers behind server.js: telling gh's failures apart, finding the
// worktree and session a PR or issue already has, working out where a PR's
// head can be fetched from, and building the brief handed to the agent. Plain
// ESM with no I/O, so server.js (loaded by the host as plain JS) imports it
// and src/ghModel.test.ts exercises it directly.

// ---- gh failures ----

// gh says what went wrong only in its exit code and stderr. Exit code 4 is
// gh's documented "authentication required"; everything else is exit 1, so
// the rest is told apart by what gh printed. Order matters: gh's "no GitHub
// remote" message ends by suggesting `gh auth login` for a new host, so the
// repository check has to run before the sign-in one.
const NOT_GITHUB_PATTERNS = [
  /none of the git remotes configured for this repository point to a known GitHub host/i,
  /no git remotes found/i,
  /not a git repository/i,
  /could not determine (the )?base repo/i,
  /no default remote repository has been set/i,
  /Could not resolve to a Repository/i,
];

const NETWORK_PATTERNS = [
  /error connecting to/i,
  /check your internet connection/i,
  /dial tcp/i,
  /no such host/i,
  /could not resolve host/i,
  /connection (refused|reset|timed out)/i,
  /network is unreachable/i,
  /i\/o timeout/i,
  /TLS handshake/i,
  /proxyconnect/i,
  /\b(EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT)\b/,
];

const AUTH_PATTERNS = [
  /gh auth login/i,
  /not logged in/i,
  /HTTP 401/i,
  /Bad credentials/i,
  /authentication required/i,
];

const PROBLEM_TEXT = {
  "gh-missing": "The GitHub CLI (gh) is not installed, or not on this machine's PATH. Install it from https://cli.github.com/.",
  network: "Could not reach GitHub. Check this machine's network connection, then press Refresh.",
  auth: "gh is not signed in to GitHub. Run `gh auth login` on this machine, then press Refresh.",
  "not-github": "This folder is not a GitHub repository gh can use.",
  gh: "gh failed.",
};

// The first non-empty line of what gh printed, capped: the lines after it are
// advice for a terminal, not for a one-line note in a panel.
export function firstLine(text) {
  const line = String(text ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

// `failure` is what server.js's run() rejects with: execFile's `code` (the
// exit code, or "ENOENT" when gh is missing), `killed` when the timeout fired,
// and gh's stderr. Returns { kind, message, detail }: `message` names the
// problem in plain words, `detail` is gh's own first line for the curious.
export function classifyGhError(failure) {
  const code = failure?.code;
  const stderr = String(failure?.stderr ?? "");
  const text = stderr || String(failure?.message ?? "");
  const detail = firstLine(text);
  const result = (kind, message = PROBLEM_TEXT[kind]) => ({ kind, message, detail });

  if (code === "ENOENT") return result("gh-missing");
  if (failure?.killed || code === "ETIMEDOUT") {
    return result("network", "gh timed out talking to GitHub. Check this machine's network connection, then press Refresh.");
  }
  if (NOT_GITHUB_PATTERNS.some((re) => re.test(text))) {
    if (/no default remote repository has been set/i.test(text)) {
      return result(
        "not-github",
        "This repository has several GitHub remotes and gh does not know which one to use. Run `gh repo set-default` in it.",
      );
    }
    if (/Could not resolve to a Repository/i.test(text)) {
      return result("not-github", "GitHub has no repository by this name that the signed-in account can see.");
    }
    return result("not-github");
  }
  if (NETWORK_PATTERNS.some((re) => re.test(text))) return result("network");
  if (code === 4 || AUTH_PATTERNS.some((re) => re.test(text))) return result("auth");
  return result("gh", detail ? `gh failed: ${detail}` : PROBLEM_TEXT.gh);
}

// ---- List filters ----

export const PAGE_SIZE = 30;
export const MAX_LIMIT = 1000;

const PR_STATES = ["open", "closed", "merged", "all"];
const ISSUE_STATES = ["open", "closed", "all"];

// gh has no offset, so "Load more" asks for a longer list. One extra row is
// requested so the reply itself says whether there is more, rather than a
// full page being taken to mean "maybe".
export function listArgs(kind, { state, mine, limit }) {
  const states = kind === "pr" ? PR_STATES : ISSUE_STATES;
  const safeState = states.includes(state) ? state : "open";
  const n = Number.parseInt(String(limit), 10);
  const safeLimit = Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_LIMIT) : PAGE_SIZE;
  const fields =
    kind === "pr"
      ? "number,title,author,headRefName,updatedAt,isDraft,url,state,isCrossRepository,headRepositoryOwner"
      : "number,title,author,updatedAt,url,state";
  const args = [kind, "list", "--state", safeState, "--limit", String(safeLimit + 1), "--json", fields];
  // Mine is the PRs you opened, and the issues assigned to you - the ones
  // you would start work on.
  if (mine) args.push(kind === "pr" ? "--author" : "--assignee", "@me");
  return { args, limit: safeLimit };
}

export function pageOf(rows, limit) {
  const list = Array.isArray(rows) ? rows : [];
  return { rows: list.slice(0, limit), hasMore: list.length > limit };
}

// ---- Worktrees and sessions ----

export function parseWorktreeList(out) {
  const rows = [];
  let current = null;
  for (const line of String(out).split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim(), branch: null, head: null, detached: false, bare: false };
      rows.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    else if (line.trim() === "detached") current.detached = true;
    else if (line.trim() === "bare") current.bare = true;
  }
  return rows;
}

// The worktree a PR or issue already has, if any. A PR's is its pr-<n>
// branch, or - for a PR from this same repository - its own head branch,
// which is what `gh pr checkout` or a plain `git switch` would have used. A
// fork's head branch name is never matched: a contributor's "main" or
// "patch-1" says nothing about which local branch is theirs. An issue's
// branch carries a slug of its title, which changes when the title does, so
// any issue-<n>-* branch is the issue's.
export function findWorktreeFor(worktrees, { kind, number, headRefName, isCrossRepository }) {
  const usable = (worktrees ?? []).filter((wt) => wt.branch && !wt.bare);
  if (kind === "pr") {
    const own = usable.find((wt) => wt.branch === `pr-${number}`);
    if (own) return own;
    if (!isCrossRepository && headRefName) return usable.find((wt) => wt.branch === headRefName) ?? null;
    return null;
  }
  const prefix = `issue-${number}-`;
  return usable.find((wt) => wt.branch === `issue-${number}` || wt.branch.startsWith(prefix)) ?? null;
}

// Byte-identical to src/client.tsx's sessionNameFor (and the bundled worktrees
// extension's) - session names can't contain "." or ":".
export function sessionNameFor(branch) {
  return String(branch).replace(/[.:/\s]+/g, "-").replace(/^-+|-+$/g, "");
}

// The open session for a worktree: the one "Start work" would have named
// after its branch, or any session rooted exactly at the worktree. Exactly,
// not "under": every worktree under .worktrees/ sits inside the main one, so
// a prefix match would hand back another PR's session. `displayPath` is the
// ~-shortened path, the convention session paths come in.
export function findSessionFor(sessions, { branch, displayPath }) {
  const real = (sessions ?? []).filter((s) => s && typeof s.name === "string" && !s.name.startsWith("perch-view-"));
  const byName = real.find((s) => s.name === sessionNameFor(branch));
  if (byName) return byName;
  return real.find((s) => s.path === displayPath) ?? null;
}

// ---- Where a PR's head comes from ----

// A branch name from GitHub, used inside a refspec. GitHub never allows
// these characters, but the name is external data and a ":" would turn
// `refs/heads/<name>` into a refspec that writes a local ref, so anything git
// itself would refuse is refused here too.
export function isSafeRefName(name) {
  if (typeof name !== "string" || name === "" || name.length > 255) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) {
    return false;
  }
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  return !/[\s:~^?*[\\\x00-\x1f\x7f]/.test(name);
}

// host/owner/name, lower-cased, from any of the URL shapes a git remote can
// have (https, ssh://, scp-like git@host:owner/name), or null.
export function normalizeRepoUrl(url) {
  const raw = String(url ?? "").trim();
  let host;
  let rest;
  const scp = raw.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      host = parsed.hostname;
      rest = parsed.pathname;
    } catch {
      return null;
    }
  } else if (scp) {
    host = scp[1];
    rest = scp[2];
  } else {
    return null;
  }
  const parts = rest.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return `${host}/${parts[0]}/${parts[1]}`.toLowerCase();
}

// `git remote -v` output as [{ name, url }], fetch URLs only. A partial
// clone's fetch line ends in its filter (`(fetch) [blob:none]`).
export function parseRemotes(out) {
  const remotes = [];
  for (const line of String(out).split("\n")) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
    if (match && !remotes.some((r) => r.name === match[1])) remotes.push({ name: match[1], url: match[2] });
  }
  return remotes;
}

// { host, nameWithOwner } of the repository a PR was opened against, from
// its web URL (https://<host>/<owner>/<name>/pull/<n>).
export function baseRepoOf(prUrl) {
  try {
    const parsed = new URL(String(prUrl));
    const [owner, name, pull] = parsed.pathname.replace(/^\/+/, "").split("/");
    if (!owner || !name || pull !== "pull") return null;
    return { host: parsed.hostname, nameWithOwner: `${owner}/${name}` };
  } catch {
    return null;
  }
}

// owner/name of the repository a PR's head branch lives in. Newer gh reports
// nameWithOwner; older gh only the repository's bare name, with the owner
// separately. Null when the head repository is gone (a deleted fork).
export function headRepoOf(pr) {
  const repo = pr?.headRepository;
  if (repo && typeof repo.nameWithOwner === "string" && repo.nameWithOwner.includes("/")) return repo.nameWithOwner;
  const owner = pr?.headRepositoryOwner?.login;
  if (repo && typeof repo.name === "string" && repo.name && typeof owner === "string" && owner) return `${owner}/${repo.name}`;
  return null;
}

function sourceFor(remotes, host, nameWithOwner, protocol) {
  const wanted = `${host}/${nameWithOwner}`.toLowerCase();
  const remote = remotes.find((r) => normalizeRepoUrl(r.url) === wanted);
  if (remote) return { source: remote.name, remote: remote.name };
  const url = protocol === "ssh" ? `git@${host}:${nameWithOwner}.git` : `https://${host}/${nameWithOwner}.git`;
  return { source: url, remote: null };
}

// Where to fetch a PR's head from, in the order to try them - the same
// places `gh pr checkout` reads. First the head branch itself, from the
// repository it lives in: a fork's when the PR came from one, through a
// remote already pointing there when there is one (its credentials already
// work), else by URL in gh's own git protocol. Then GitHub's
// refs/pull/<n>/head on the base repository, which still works once a fork
// is deleted. Neither assumes the base repository is called "origin": in a
// clone of your own fork it usually isn't. `upstream` is what the new local
// branch should track, set only from the head-branch source.
export function prFetchPlan(pr, remotes, protocol) {
  const base = baseRepoOf(pr?.url);
  if (!base) return [];
  const plan = [];
  const head = headRepoOf(pr);
  if (head && isSafeRefName(pr.headRefName)) {
    const { source } = sourceFor(remotes, base.host, head, protocol);
    plan.push({
      source,
      ref: `refs/heads/${pr.headRefName}`,
      label: `${head} ${pr.headRefName}`,
      upstream: { remote: source, merge: `refs/heads/${pr.headRefName}` },
    });
  }
  const { source } = sourceFor(remotes, base.host, base.nameWithOwner, protocol);
  plan.push({ source, ref: `refs/pull/${pr.number}/head`, label: `${base.nameWithOwner} pull/${pr.number}/head`, upstream: null });
  return plan;
}

// ---- The brief handed to the agent ----

function trimBody(body) {
  const text = String(body ?? "").trim();
  return text ? text : "(No description.)";
}

export function buildIssueBrief(issue) {
  const lines = [`Issue #${issue.number}: ${issue.title}`];
  if (issue.url) lines.push(issue.url);
  lines.push("", trimBody(issue.body));
  return lines.join("\n");
}

// What the agent starts from on a PR: which branch it is on and where that
// came from, then the PR's own description - the author's account of what the
// change is for, which a title alone never carries.
export function buildPrBrief(pr) {
  const lines = [`PR #${pr.number}: ${pr.title}`];
  if (pr.url) lines.push(pr.url);
  const head = headRepoOf(pr);
  const from = pr.isCrossRepository && head ? ` (from ${head})` : "";
  if (pr.headRefName && pr.baseRefName) lines.push(`Branch: ${pr.headRefName}${from} into ${pr.baseRefName}`);
  if (pr.author?.login) lines.push(`Author: ${pr.author.login}`);
  lines.push("", trimBody(pr.body));
  return lines.join("\n");
}
