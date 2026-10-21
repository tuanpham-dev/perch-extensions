// A window's Claude transcript is found whatever its folder is called: Claude
// Code names a project dir by turning every character of the path that isn't
// a letter or digit into "-", and a folder with a space or an underscore used
// to find nothing and show as idle. HOME points at a scratch folder before
// anything is imported, so ~/.claude here is the test's own.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = await mkdtemp(path.join(tmpdir(), "am-transcripts-"));
process.env.HOME = home;
const { claudeProjectDirs, mostRecentTranscript, sessionTranscript } = await import("../transcripts.mjs");
const server = await import("../server.js");

const root = path.join(home, ".claude", "projects");

test("Claude Code's slug turns every non-alphanumeric character into a dash", () => {
  // Claude Code's own rule first; the older one (only / and .) second.
  assert.deepEqual(claudeProjectDirs("/r", "/home/x/my_app proj"), ["/r/-home-x-my-app-proj", "/r/-home-x-my_app proj"]);
  assert.deepEqual(claudeProjectDirs("/r", "/home/x/app.js"), ["/r/-home-x-app-js"], "the same slug twice collapses");
  assert.deepEqual(claudeProjectDirs("/r", "~/code"), [`/r/${`${home}/code`.replace(/[^a-zA-Z0-9]/g, "-")}`], "a ~ path is expanded first");
  assert.deepEqual(claudeProjectDirs("/r", ""), []);
});

test("a transcript in a folder with a space and an underscore is found", async () => {
  const dir = path.join(root, "-home-x-my-app-proj");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "old.jsonl"), "{}\n");
  await writeFile(path.join(dir, "new.jsonl"), "{}\n");
  await utimes(path.join(dir, "old.jsonl"), new Date(1_000_000), new Date(1_000_000));
  const recent = await mostRecentTranscript(root, "/home/x/my_app proj");
  assert.equal(recent?.id, "new");
  assert.equal((await sessionTranscript(root, "/home/x/my_app proj", "old"))?.id, "old");
  assert.equal(await sessionTranscript(root, "/home/x/my_app proj", "missing"), null);
  assert.equal(await mostRecentTranscript(root, "/home/x/elsewhere"), null);
});

test("a transcript under the older dir name is still found", async () => {
  const dir = path.join(root, "-home-x-legacy_dir");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "s1.jsonl"), "{}\n");
  assert.equal((await mostRecentTranscript(root, "/home/x/legacy_dir"))?.id, "s1");
});

// ---- The server, against a fake host ----

type Handler = (req: unknown, res: unknown) => void | Promise<void>;
const routes = new Map<string, Handler>();
let onHookEvent: ((e: unknown) => void) | null = null;
let sessionsChanged: (() => void) | null = null;
const project = path.join(home, "work", "my_app proj");
let windows = [
  { id: "w-claude", index: 0, name: "claude", cwd: project, command: "claude" },
  { id: "w-other", index: 1, name: "claude", cwd: project, command: "claude" },
];
const host = {
  agents: { list: async () => [{ id: "t.claude", label: "Claude Code", program: "claude" }] },
  agentHooks: {
    subscribe(sub: { onEvent: (e: unknown) => void }) {
      onHookEvent = sub.onEvent;
      return () => {};
    },
  },
  sessions: {
    list: async () => [{ name: "s", path: project, windows }],
    onChange(cb: () => void) {
      sessionsChanged = cb;
      return () => {};
    },
  },
};
server.activate({
  router: { get: (p: string, h: Handler) => routes.set(p, h) },
  getSettings: async () => ({}),
  host,
});

async function agents(): Promise<{ paneId: string; state: string; lastActivityAt: number | null }[]> {
  return new Promise((resolve, reject) => {
    const res = {
      status: () => res,
      json: (body: { agents?: never[]; error?: string }) => (body.agents ? resolve(body.agents) : reject(new Error(body.error))),
    };
    void routes.get("/agents")!({ query: {} }, res);
  });
}

test("a window in such a folder is classified from its transcript, not left idle", async () => {
  const dir = path.join(root, project.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "live.jsonl"), "{}\n");
  const row = (await agents()).find((a) => a.paneId === "w-claude");
  assert.equal(row?.state, "working", "just written, so working");
  assert.ok(row?.lastActivityAt, "the transcript's mtime is the activity time");
});

test("a closed window's state goes when the sessions change", async () => {
  onHookEvent!({ event: "prompt-submit", paneId: "w-claude", agent: "t.claude", payload: {} });
  onHookEvent!({ event: "prompt-submit", paneId: "w-other", agent: "t.claude", payload: {} });
  await agents();
  assert.deepEqual(server.heldForWindow("w-other"), { hook: true, classified: true, agent: false });

  windows = windows.filter((w) => w.id !== "w-other");
  assert.ok(sessionsChanged, "subscribed to host.sessions.onChange");
  sessionsChanged!();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(server.heldForWindow("w-other"), { hook: false, classified: false, agent: false });
  assert.equal(server.heldForWindow("w-claude").hook, true, "a window still open keeps its record");
});
