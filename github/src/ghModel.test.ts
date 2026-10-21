// The pure half of the github server hook. Error messages are gh's real
// stderr (gh 2.102), so a change in how they are told apart shows up here
// rather than as a panel that says "gh failed" for a laptop that is offline.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildIssueBrief,
  buildPrBrief,
  classifyGhError,
  findSessionFor,
  findWorktreeFor,
  isSafeRefName,
  listArgs,
  normalizeRepoUrl,
  pageOf,
  parseRemotes,
  parseWorktreeList,
  prFetchPlan,
} from "../ghModel.mjs";

// ---- classifyGhError ----

test("a missing gh binary is gh-missing", () => {
  assert.equal(classifyGhError({ code: "ENOENT", message: "spawn gh ENOENT" }).kind, "gh-missing");
});

test("exit code 4 is not signed in", () => {
  const stderr =
    "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n";
  const problem = classifyGhError({ code: 4, stderr });
  assert.equal(problem.kind, "auth");
  assert.equal(problem.detail, "To get started with GitHub CLI, please run:  gh auth login");
});

test("a bad token is not signed in", () => {
  const stderr = "HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login -h github.com\n";
  assert.equal(classifyGhError({ code: 1, stderr }).kind, "auth");
});

test("a non-GitHub remote is not-github, even though gh suggests gh auth login", () => {
  const stderr =
    "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n";
  assert.equal(classifyGhError({ code: 1, stderr }).kind, "not-github");
});

test("no remotes and no repository are not-github", () => {
  assert.equal(classifyGhError({ code: 1, stderr: "no git remotes found\n" }).kind, "not-github");
  assert.equal(
    classifyGhError({ code: 1, stderr: "failed to run git: fatal: not a git repository (or any parent up to mount point /)\n" }).kind,
    "not-github",
  );
});

test("several remotes with no default names the fix", () => {
  const problem = classifyGhError({ code: 1, stderr: "X No default remote repository has been set. To learn more about the default repository, run: gh repo set-default --help\n" });
  assert.equal(problem.kind, "not-github");
  assert.match(problem.message, /gh repo set-default/);
});

test("offline, DNS and proxy failures are network", () => {
  for (const stderr of [
    "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n",
    'Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused\n',
    'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host\n',
  ]) {
    assert.equal(classifyGhError({ code: 1, stderr }).kind, "network", stderr);
  }
});

test("a timed-out gh is network", () => {
  assert.equal(classifyGhError({ code: null, killed: true, stderr: "" }).kind, "network");
});

test("anything else keeps gh's own first line", () => {
  const problem = classifyGhError({ code: 1, stderr: "GraphQL: Something odd happened\nmore\n" });
  assert.equal(problem.kind, "gh");
  assert.equal(problem.message, "gh failed: GraphQL: Something odd happened");
});

// ---- listArgs / pageOf ----

test("list args carry the state, Mine and one row past the limit", () => {
  const { args, limit } = listArgs("pr", { state: "merged", mine: true, limit: "60" });
  assert.equal(limit, 60);
  assert.deepEqual(args.slice(0, 6), ["pr", "list", "--state", "merged", "--limit", "61"]);
  assert.deepEqual(args.slice(-2), ["--author", "@me"]);
  assert.ok(args[args.indexOf("--json") + 1].includes("isCrossRepository"));
});

test("issues have no merged state and Mine means assigned", () => {
  const { args } = listArgs("issue", { state: "merged", mine: true, limit: undefined });
  assert.deepEqual(args.slice(0, 6), ["issue", "list", "--state", "open", "--limit", "31"]);
  assert.deepEqual(args.slice(-2), ["--assignee", "@me"]);
});

test("the limit is clamped", () => {
  assert.equal(listArgs("pr", { state: "all", mine: false, limit: "99999" }).limit, 1000);
  assert.equal(listArgs("pr", { state: "all", mine: false, limit: "-3" }).limit, 1);
});

test("pageOf says whether there is more", () => {
  const rows = Array.from({ length: 31 }, (_, i) => i);
  assert.deepEqual(pageOf(rows, 30), { rows: rows.slice(0, 30), hasMore: true });
  assert.deepEqual(pageOf(rows.slice(0, 30), 30), { rows: rows.slice(0, 30), hasMore: false });
});

// ---- Worktree and session matching ----

const porcelain = [
  "worktree /home/u/repo",
  "HEAD aaaa",
  "branch refs/heads/main",
  "",
  "worktree /home/u/repo/.worktrees/pr-12",
  "HEAD bbbb",
  "branch refs/heads/pr-12",
  "",
  "worktree /home/u/repo/.worktrees/issue-7-old-title",
  "HEAD cccc",
  "branch refs/heads/issue-7-old-title",
  "",
  "worktree /home/u/repo/.worktrees/feature-x",
  "HEAD dddd",
  "branch refs/heads/feature-x",
  "",
  "worktree /home/u/repo/.worktrees/detached",
  "HEAD eeee",
  "detached",
  "",
].join("\n");

test("parseWorktreeList reads branches and detached heads", () => {
  const rows = parseWorktreeList(porcelain);
  assert.equal(rows.length, 5);
  assert.equal(rows[1].branch, "pr-12");
  assert.equal(rows[4].detached, true);
  assert.equal(rows[4].branch, null);
});

test("a PR's worktree is its pr-<n> branch", () => {
  const rows = parseWorktreeList(porcelain);
  assert.equal(findWorktreeFor(rows, { kind: "pr", number: 12 })?.path, "/home/u/repo/.worktrees/pr-12");
  assert.equal(findWorktreeFor(rows, { kind: "pr", number: 1 }), null);
});

test("a same-repo PR's head branch counts, a fork's does not", () => {
  const rows = parseWorktreeList(porcelain);
  assert.equal(
    findWorktreeFor(rows, { kind: "pr", number: 40, headRefName: "feature-x", isCrossRepository: false })?.branch,
    "feature-x",
  );
  // A fork PR from the contributor's "main" is not this checkout's main.
  assert.equal(findWorktreeFor(rows, { kind: "pr", number: 41, headRefName: "main", isCrossRepository: true }), null);
});

test("an issue's worktree survives a renamed title, but not a longer number", () => {
  const rows = parseWorktreeList(porcelain);
  assert.equal(findWorktreeFor(rows, { kind: "issue", number: 7 })?.branch, "issue-7-old-title");
  assert.equal(findWorktreeFor(rows, { kind: "issue", number: 70 }), null);
});

test("the session is found by name, else by exact path", () => {
  const sessions = [
    { name: "repo", path: "~/repo", windows: [] },
    { name: "perch-view-pr-12", path: "~/repo/.worktrees/pr-12", windows: [] },
    { name: "my-review", path: "~/repo/.worktrees/pr-12", windows: [] },
    { name: "issue-7-old-title", path: "~/elsewhere", windows: [] },
  ];
  assert.equal(findSessionFor(sessions, { branch: "pr-12", displayPath: "~/repo/.worktrees/pr-12" })?.name, "my-review");
  assert.equal(
    findSessionFor(sessions, { branch: "issue-7-old-title", displayPath: "~/repo/.worktrees/issue-7-old-title" })?.name,
    "issue-7-old-title",
  );
  // The main checkout's session is not every worktree's session.
  assert.equal(findSessionFor(sessions, { branch: "pr-99", displayPath: "~/repo/.worktrees/pr-99" }), null);
});

// ---- Fork PR fetch plan ----

test("isSafeRefName refuses refspec and option tricks", () => {
  assert.equal(isSafeRefName("fix/issue-create"), true);
  for (const bad of ["x:refs/heads/main", "-upload-pack=evil", "a..b", "a b", "", "a.lock", "x~1"]) {
    assert.equal(isSafeRefName(bad), false, bad);
  }
});

test("normalizeRepoUrl matches every remote URL shape", () => {
  for (const url of [
    "https://github.com/Cli/CLI.git",
    "https://github.com/cli/cli",
    "git@github.com:cli/cli.git",
    "ssh://git@github.com/cli/cli.git",
    "https://user@github.com/cli/cli/",
  ]) {
    assert.equal(normalizeRepoUrl(url), "github.com/cli/cli", url);
  }
  assert.equal(normalizeRepoUrl("/some/local/path"), null);
});

test("parseRemotes keeps fetch URLs", () => {
  const out = "origin\tgit@github.com:me/cli.git (fetch)\norigin\tgit@github.com:me/cli.git (push)\nupstream\thttps://github.com/cli/cli.git (fetch)\n";
  assert.deepEqual(parseRemotes(out), [
    { name: "origin", url: "git@github.com:me/cli.git" },
    { name: "upstream", url: "https://github.com/cli/cli.git" },
  ]);
});

test("parseRemotes reads a partial clone's fetch line", () => {
  assert.deepEqual(parseRemotes("origin\thttps://github.com/cli/cli (fetch) [blob:none]\norigin\thttps://github.com/cli/cli (push)\n"), [
    { name: "origin", url: "https://github.com/cli/cli" },
  ]);
});

// Shape of `gh pr view --json ...` for a real fork PR on cli/cli.
const forkPr = {
  number: 14727,
  url: "https://github.com/cli/cli/pull/14727",
  headRefName: "fix/issue-create-resolve-type-before-create",
  headRepository: { id: "R_kgDOVNhOyA", name: "cli", nameWithOwner: "umairnaeem0309/cli" },
  headRepositoryOwner: { id: "U_kgDOCTHP_w", login: "umairnaeem0309" },
  isCrossRepository: true,
};

test("a fork PR fetches its head branch from the fork, then pull/<n>/head from the base", () => {
  const plan = prFetchPlan(forkPr, [], "https");
  assert.deepEqual(
    plan.map((step) => [step.source, step.ref]),
    [
      ["https://github.com/umairnaeem0309/cli.git", "refs/heads/fix/issue-create-resolve-type-before-create"],
      ["https://github.com/cli/cli.git", "refs/pull/14727/head"],
    ],
  );
  assert.deepEqual(plan[0].upstream, {
    remote: "https://github.com/umairnaeem0309/cli.git",
    merge: "refs/heads/fix/issue-create-resolve-type-before-create",
  });
});

test("the base repository is found by URL, not assumed to be origin", () => {
  // A clone of your own fork: origin is the fork, upstream is the base.
  const remotes = [
    { name: "origin", url: "git@github.com:me/cli.git" },
    { name: "upstream", url: "https://github.com/cli/cli.git" },
  ];
  const plan = prFetchPlan(forkPr, remotes, "ssh");
  assert.equal(plan[0].source, "git@github.com:umairnaeem0309/cli.git");
  assert.equal(plan[1].source, "upstream");
});

test("older gh without nameWithOwner still finds the fork", () => {
  const plan = prFetchPlan({ ...forkPr, headRepository: { id: "x", name: "cli" } }, [], "https");
  assert.equal(plan[0].source, "https://github.com/umairnaeem0309/cli.git");
});

test("a deleted fork falls back to pull/<n>/head alone", () => {
  const plan = prFetchPlan({ ...forkPr, headRepository: null, headRepositoryOwner: null }, [], "https");
  assert.deepEqual(plan.map((step) => step.ref), ["refs/pull/14727/head"]);
});

test("an unsafe head branch name is never put into a refspec", () => {
  const plan = prFetchPlan({ ...forkPr, headRefName: "x:refs/heads/main" }, [], "https");
  assert.deepEqual(plan.map((step) => step.ref), ["refs/pull/14727/head"]);
});

// ---- Briefs ----

test("the PR brief carries the PR's description", () => {
  const brief = buildPrBrief({
    ...forkPr,
    title: "Resolve issue type before create",
    baseRefName: "trunk",
    author: { login: "umairnaeem0309" },
    body: "Fixes #123.\n\nResolves the type first.",
  });
  assert.equal(
    brief,
    [
      "PR #14727: Resolve issue type before create",
      "https://github.com/cli/cli/pull/14727",
      "Branch: fix/issue-create-resolve-type-before-create (from umairnaeem0309/cli) into trunk",
      "Author: umairnaeem0309",
      "",
      "Fixes #123.\n\nResolves the type first.",
    ].join("\n"),
  );
});

test("an empty body says so rather than ending abruptly", () => {
  assert.match(buildPrBrief({ number: 1, title: "t", body: "  " }), /\(No description\.\)$/);
});

test("the issue brief keeps title, link and body", () => {
  assert.equal(
    buildIssueBrief({ number: 7, title: "Crash", url: "https://github.com/o/r/issues/7", body: "Steps" }),
    "Issue #7: Crash\nhttps://github.com/o/r/issues/7\n\nSteps",
  );
});
