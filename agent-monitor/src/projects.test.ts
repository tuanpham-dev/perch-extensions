// A project is the repository, not the checkout folder: every worktree of one
// repo has to answer with the same project so the board groups them together,
// while still naming the branch each window is actually on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clearProjectCache, expandHome, pickWorktree, resolveProject } from "../projects.mjs";
import { homedir } from "node:os";

interface Worktree {
  path: string;
  branch: string | null;
  main?: boolean;
  detached?: boolean;
}

const REPO = "/works/perch";
const WORKTREES: Worktree[] = [
  { path: REPO, branch: "main", main: true },
  { path: "/works/perch/.worktrees/feature-x", branch: "feature/x" },
  { path: "/works/perch/.worktrees/spike", branch: null, detached: true },
];

function hostWith(worktrees: Worktree[] | null, repo: string | null = REPO) {
  return {
    worktrees: {
      list: async () => ({ repo, worktrees: worktrees ?? [], branches: [] }),
    },
  };
}

test("expands a ~-shortened path", () => {
  assert.equal(expandHome("~/works/perch"), `${homedir()}/works/perch`);
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("/works/perch"), "/works/perch");
  assert.equal(expandHome(""), "");
});

test("picks the deepest worktree containing the folder", () => {
  // Linked worktrees nest inside the repo, so the main worktree is a prefix
  // of every one of them - the longest match is the only correct answer.
  assert.equal(pickWorktree(WORKTREES, "/works/perch/.worktrees/feature-x/server")?.branch, "feature/x");
  assert.equal(pickWorktree(WORKTREES, REPO)?.branch, "main");
  assert.equal(pickWorktree(WORKTREES, "/works/other")?.branch, undefined);
  // A sibling folder whose name merely starts with a worktree's path is not
  // inside it.
  assert.equal(pickWorktree(WORKTREES, "/works/perch-extensions")?.branch, undefined);
  assert.equal(pickWorktree([], REPO), null);
});

test("a session in the repository's own checkout", async () => {
  clearProjectCache();
  const project = await resolveProject(hostWith(WORKTREES), REPO);
  assert.deepEqual(project, { repo: REPO, project: "perch", branch: "main", linked: false });
});

test("a session in a linked worktree keeps the repository as its project", async () => {
  clearProjectCache();
  const project = await resolveProject(hostWith(WORKTREES), "/works/perch/.worktrees/feature-x");
  assert.deepEqual(project, { repo: REPO, project: "perch", branch: "feature/x", linked: true });
});

test("a detached worktree has no branch to name", async () => {
  clearProjectCache();
  const project = await resolveProject(hostWith(WORKTREES), "/works/perch/.worktrees/spike");
  assert.equal(project.branch, null);
  assert.equal(project.linked, true);
});

test("a folder outside any repository becomes its own project", async () => {
  clearProjectCache();
  const project = await resolveProject(hostWith([], null), "/works/notes");
  assert.deepEqual(project, { repo: "/works/notes", project: "notes", branch: null, linked: false });
});

test("a host with no worktrees API still answers", async () => {
  clearProjectCache();
  const project = await resolveProject({}, "/works/notes");
  assert.deepEqual(project, { repo: "/works/notes", project: "notes", branch: null, linked: false });
});

test("a listing that throws falls back to the folder", async () => {
  clearProjectCache();
  const host = {
    worktrees: {
      list: async () => {
        throw new Error("not a git repository");
      },
    },
  };
  const project = await resolveProject(host, "/works/notes");
  assert.equal(project.project, "notes");
});

test("a ~-shortened cwd resolves like an absolute one", async () => {
  clearProjectCache();
  const home = homedir();
  const host = hostWith([{ path: `${home}/code/app`, branch: "main", main: true }], `${home}/code/app`);
  const project = await resolveProject(host, "~/code/app");
  assert.deepEqual(project, { repo: `${home}/code/app`, project: "app", branch: "main", linked: false });
});

test("the answer is cached per folder", async () => {
  clearProjectCache();
  let calls = 0;
  const host = {
    worktrees: {
      list: async () => {
        calls++;
        return { repo: REPO, worktrees: WORKTREES, branches: [] };
      },
    },
  };
  await resolveProject(host, REPO);
  await resolveProject(host, REPO);
  assert.equal(calls, 1);
  // A different folder is a different question, cached separately.
  await resolveProject(host, "/works/perch/.worktrees/feature-x");
  assert.equal(calls, 2);
});
