// The review runner against a fake host: what is recorded before anything is
// made, which checkout a pull request is matched to, and what a vanished
// window does to a running task.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createReviewRunner, originMatches, sessionNameFor } from "../reviewRunner.mjs";
import { createReviewStore } from "../reviewStore.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100e221bc330000000049454e44ae426082", "hex");

async function repoWithOrigin(dir: string, origin: string) {
  await mkdir(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return dir;
}

async function repoRoot(cwd: string) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function detail(comments: string[]) {
  return {
    key: "CAP-5",
    summary: "Fix buy box",
    description: "",
    status: "Open",
    type: "Bug",
    priority: null,
    labels: [],
    created: "2026-01-01T00:00:00.000Z",
    comments: comments.map((body, i) => ({ author: "A", created: `2026-01-0${i + 2}T00:00:00.000Z`, body })),
    url: "https://j/browse/CAP-5",
  };
}

async function setup({ comments, projectMap = {} }: { comments: string[]; projectMap?: Record<string, string> }) {
  const dir = await mkdtemp(path.join(tmpdir(), "jira-review-runner-"));
  const store = createReviewStore(dir);
  const calls: string[] = [];
  const windows = new Set<string>();
  const host = {
    sessions: {
      async create(name: string, cwd: string) {
        const doc = await store.get();
        calls.push(`create ${name} with ${doc.reviews["CAP-5"]?.tasks?.qa?.state ?? doc.reviews["CAP-5"]?.tasks?.code?.state}`);
        windows.add(`w-${name}`);
        return { name, cwd };
      },
      async listPanes(name: string) {
        return [{ id: `w-${name}` }];
      },
      async sendTextToWindow(id: string, text: string) {
        calls.push(`send ${id} ${text.slice(0, 40)}`);
      },
      async kill(name: string) {
        windows.delete(`w-${name}`);
        calls.push(`kill ${name}`);
      },
      async list() {
        return [{ windows: [...windows].map((id) => ({ id })) }];
      },
    },
    worktrees: { async create() { throw new Error("not in these tests"); } },
    agents: { async launchCommand(id: string) { return id === "perch.agents.claude" ? "claude" : null; } },
  };
  const runner = createReviewRunner({
    host,
    store,
    configDir: dir,
    readConfig: async () => ({ siteUrl: "https://j", email: "e", apiToken: "t", settings: {} }),
    issueDetail: async () => detail(comments),
    settingsForRepo: async () => ({}),
    getSettings: async () => ({ "jira.projectMap": JSON.stringify(projectMap) }),
    repoRoot,
    resolveLocation: (t: string, repo: string, b: string) => path.join(repo, b),
    storefrontPassword: async (project: string) => (project === "CAP" ? "pw" : ""),
    controlSocket: () => ({ socketPath: "/tmp/s.sock", binDir: "/tmp/bin" }),
    log: () => {},
  });
  return { dir, store, calls, windows, runner };
}

test("origins match in https and ssh form, without case or .git", () => {
  assert.ok(originMatches("https://github.com/Barrel/Carepod-Theme.git", "barrel", "carepod-theme"));
  assert.ok(originMatches("git@github.com:barrel/carepod-theme", "barrel", "carepod-theme"));
  assert.ok(!originMatches("git@github.com:barrel/carepod-theme-old.git", "barrel", "carepod-theme"));
  assert.equal(sessionNameFor("CAP-5", "qa"), "review-cap-5-qa");
});

test("a pull request is matched to the active window's checkout before the project map's", async () => {
  const { dir, runner } = await setup({ comments: [] });
  const active = await repoWithOrigin(path.join(dir, "active"), "git@github.com:o/r.git");
  const mapped = await repoWithOrigin(path.join(dir, "mapped"), "https://github.com/o/r");
  const other = await repoWithOrigin(path.join(dir, "other"), "https://github.com/o/else");
  const r1 = await setup({ comments: [], projectMap: { [mapped]: "CAP" } });
  assert.equal(await r1.runner.locateRepo({ owner: "o", repo: "r", cwd: active }), active);
  assert.equal(await r1.runner.locateRepo({ owner: "o", repo: "r", cwd: other }), mapped);
  assert.equal(await runner.locateRepo({ owner: "o", repo: "r", cwd: other }), null);
});

test("a code review of a repository checked out nowhere known asks rather than starts", async () => {
  const { runner, calls, store } = await setup({ comments: ["https://github.com/o/nowhere/pull/3"] });
  const result = await runner.start("CAP-5", { tasks: ["code"], agentId: "perch.agents.claude", cwd: tmpdir() });
  assert.deepEqual(result, { needsRepo: { owner: "o", repo: "nowhere" } });
  assert.deepEqual(calls, []);
  assert.equal((await store.get()).reviews["CAP-5"], undefined);
});

test("visual QA is recorded as running before its session exists, with the skill in its folder", async () => {
  const { dir, runner, calls, store } = await setup({ comments: ["https://s.com/products/a?preview_theme_id=9"] });
  const repo = await repoWithOrigin(path.join(dir, "repo"), "git@github.com:o/r.git");
  const result = await runner.start("CAP-5", { tasks: ["qa"], agentId: "perch.agents.claude", cwd: repo });
  assert.equal(result.tasks[0].cwd, repo);
  assert.equal(calls[1], "create review-cap-5-qa with running");
  assert.match(calls[2], /^send w-review-cap-5-qa export JB_SOCK=/);
  await stat(path.join(repo, ".claude/skills/jira-review-qa/SKILL.md"));
  const exclude = await readFile(path.join(repo, ".git/info/exclude"), "utf8");
  assert.ok(exclude.includes("/.claude/skills/jira-review-qa/"));
  const task = (await store.get()).reviews["CAP-5"].tasks.qa;
  assert.equal(task.windowId, "w-review-cap-5-qa");

  // Its brief names the preview, the page from the link and the password.
  const brief = await runner.verbs()["review-brief"]({ key: "CAP-5", task: "qa" });
  assert.ok(brief.text.includes("Preview: https://s.com/products/a?preview_theme_id=9"));
  assert.ok(brief.text.includes("- /products/a"));
  assert.ok(brief.text.includes("Storefront password: pw"));
});

test("a QA report copies its screenshots, and a bad image leaves the old ones alone", async () => {
  const { dir, runner, store } = await setup({ comments: ["https://s.com/?preview_theme_id=9"] });
  await runner.start("CAP-5", { tasks: ["qa"], agentId: "perch.agents.claude", cwd: tmpdir() });
  const shot = path.join(dir, "a.png");
  await writeFile(shot, PNG);
  const verbs = runner.verbs();
  await assert.rejects(
    verbs["review-qa"]({ key: "CAP-5", task: "qa", status: "pass", pages: [{ page: "/", "before-1440": path.join(dir, "missing.png") }] }),
    /no file at/,
  );
  assert.equal((await store.get()).reviews["CAP-5"].tasks.qa.state, "running");
  const ok = await verbs["review-qa"]({
    key: "CAP-5",
    task: "qa",
    status: "pass",
    checked: ["home"],
    pages: [{ page: "/", "before-1440": shot, "after-1440": shot, shots: [{ file: shot, caption: "menu" }] }],
  });
  assert.deepEqual(ok, { key: "CAP-5", status: "pass", pages: 1 });
  const served = await runner.shotFile("CAP-5", "home", "after-1440");
  assert.ok(served?.file.endsWith(path.join("reviews", "CAP-5", "home-after-1440.png")));
  assert.equal((await runner.shotFile("CAP-5", "home", "shot-1"))?.type, "image/png");
  assert.equal(await runner.shotFile("CAP-5", "home", "before-390"), null);
  await assert.rejects(verbs["review-code"]({ key: "CAP-5", task: "qa", verdict: "approve", summary: "x" }), /visual QA agent's shell/);
});

test("a running task whose window is gone is marked failed by the sweep", async () => {
  const { runner, windows, store } = await setup({ comments: ["https://s.com/?preview_theme_id=9"] });
  await runner.start("CAP-5", { tasks: ["qa"], agentId: "perch.agents.claude", cwd: tmpdir() });
  windows.clear();
  await runner.sweep();
  const task = (await store.get()).reviews["CAP-5"].tasks.qa;
  assert.equal(task.state, "failed");
  assert.equal(task.error, "its terminal window is gone");
});

// ---- the pull request's checkout, end to end (git and the agent's command are real) ----

import { createControlServer } from "../batchControl.mjs";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

// An origin at .../o/r.git that carries a pull request ref the way GitHub
// does, and a clone of it standing in for the user's checkout.
async function originWithPullRequest(dir: string) {
  const seed = path.join(dir, "seed");
  await mkdir(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  await writeFile(path.join(seed, "a.txt"), "main\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "main");
  git(seed, "checkout", "-q", "-b", "feature");
  await writeFile(path.join(seed, "a.txt"), "pull request\n");
  git(seed, "commit", "-q", "-am", "the change");
  const bare = path.join(dir, "o", "r.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
  git(bare, "update-ref", "refs/pull/7/head", git(seed, "rev-parse", "feature"));
  const local = path.join(dir, "local");
  execFileSync("git", ["clone", "-q", bare, local]);
  return { seed, bare, local };
}

test("a code review checks the pull request's head out into its own worktree, and the agent's report arrives over the socket", async () => {
  const ctx = await setup({ comments: ["Please review https://github.com/o/r/pull/7"] });
  const { seed, bare, local } = await originWithPullRequest(ctx.dir);
  const created: string[] = [];
  // The host's worktree API, as `git worktree` does it.
  (ctx as any).runner = createReviewRunner({
    ...(await (async () => ({}))()),
    host: {
      sessions: {
        create: async (name: string, cwd: string) => ({ name, cwd }),
        listPanes: async (name: string) => [{ id: `w-${name}` }],
        sendTextToWindow: async () => {},
        kill: async () => {},
        list: async () => [],
      },
      worktrees: {
        async create({ cwd, branch }: { cwd: string; branch: string }) {
          const target = path.join(cwd, ".worktrees", branch.replace(/\//g, "-"));
          git(cwd, "worktree", "add", "-q", target, branch);
          // The host excludes an in-repo location, as core's does.
          await writeFile(path.join(cwd, ".git", "info", "exclude"), "/.worktrees/\n", { flag: "a" });
          created.push(target);
          return { path: target, branch };
        },
        async remove({ cwd, path: target }: { cwd: string; path: string }) {
          git(cwd, "worktree", "remove", "--force", target);
          return { removed: true };
        },
      },
      agents: { launchCommand: async () => "claude" },
    },
    store: ctx.store,
    configDir: ctx.dir,
    readConfig: async () => ({ siteUrl: "https://j", email: "e", apiToken: "t", settings: {} }),
    issueDetail: async () => detail(["Please review https://github.com/o/r/pull/7"]),
    settingsForRepo: async () => ({}),
    getSettings: async () => ({}),
    repoRoot,
    resolveLocation: (_t: string, repo: string, b: string) => path.join(repo, ".worktrees", b.replace(/\//g, "-")),
    controlSocket: () => ({ socketPath: "/unused", binDir: "/unused" }),
    log: () => {},
  });
  const runner = (ctx as any).runner;

  const userBranch = git(local, "rev-parse", "--abbrev-ref", "HEAD");
  const result = await runner.start("CAP-5", { tasks: ["code"], agentId: "perch.agents.claude", cwd: local });
  const worktree = result.worktreePath;
  assert.equal(worktree, created[0]);
  assert.equal(git(worktree, "rev-parse", "HEAD"), git(seed, "rev-parse", "feature"), "checked out at the pull request's head");
  assert.equal(await readFile(path.join(worktree, "a.txt"), "utf8"), "pull request\n");
  assert.equal(git(local, "rev-parse", "--abbrev-ref", "HEAD"), userBranch, "the user's own checkout is untouched");
  assert.equal(git(local, "status", "--porcelain"), "", "and clean");

  // The agent reports with the real command over a real socket.
  const socketPath = path.join(ctx.dir, "c.sock");
  const control = createControlServer({ socketPath, handlers: runner.verbs(), log: () => {} });
  await control.start();
  try {
    const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "cli", "jira-review");
    const env = { ...process.env, JB_SOCK: socketPath, JR_KEY: "CAP-5", JR_TASK: "code" };
    // Async: the socket answering it lives on this same event loop.
    const run = promisify(execFile);
    const brief = (await run(cli, ["brief"], { env, encoding: "utf8" })).stdout;
    assert.ok(brief.includes(`This folder (${worktree}) is a checkout of the pull request's head`));
    await run(cli, ["code", "--verdict", "request-changes", "--summary", "One bug", "--finding", "high:a.txt:1:wrong text"], { env, encoding: "utf8" });
  } finally {
    await control.stop();
  }
  const report = (await ctx.store.get()).reviews["CAP-5"].tasks.code.report;
  assert.equal(report.verdict, "request-changes");
  assert.deepEqual(report.findings[0], { severity: "high", file: "a.txt", line: 1, text: "wrong text" });

  // Run again after the pull request moved: same worktree, new head.
  await writeFile(path.join(seed, "a.txt"), "second round\n");
  git(seed, "commit", "-q", "-am", "round two");
  git(bare, "fetch", "-q", seed, "+feature:refs/pull/7/head");
  await runner.start("CAP-5", { tasks: ["code"], agentId: "perch.agents.claude", cwd: local });
  assert.equal(created.length, 1, "the worktree is reused");
  assert.equal(await readFile(path.join(worktree, "a.txt"), "utf8"), "second round\n");

  // Closing removes the checkout and keeps nothing running.
  await runner.stop("CAP-5", "code");
  await runner.close("CAP-5");
  await assert.rejects(stat(worktree));
  assert.equal((await ctx.store.get()).reviews["CAP-5"].worktreePath, "");
});

test("visual QA uses the active repository only when the ticket names no pull request", async () => {
  const withPr = await setup({ comments: ["https://github.com/o/elsewhere/pull/1", "https://s.com/?preview_theme_id=9"] });
  const active = await repoWithOrigin(path.join(withPr.dir, "active"), "git@github.com:o/unrelated.git");
  const r1 = await withPr.runner.start("CAP-5", { tasks: ["qa"], agentId: "perch.agents.claude", cwd: active });
  assert.equal(r1.tasks[0].cwd, path.join(withPr.dir, "jira", "review-scratch", "CAP-5"), "not the unrelated checkout");

  const noPr = await setup({ comments: ["https://s.com/?preview_theme_id=9"] });
  const theme = await repoWithOrigin(path.join(noPr.dir, "theme"), "git@github.com:o/theme.git");
  const r2 = await noPr.runner.start("CAP-5", { tasks: ["qa"], agentId: "perch.agents.claude", cwd: theme });
  assert.equal(r2.tasks[0].cwd, theme);
});
