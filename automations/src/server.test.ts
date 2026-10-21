// automations' server end to end (acceptance A29), against an in-memory
// storage and a fake agent-tasks control socket that speaks the same
// `subscribe` / `task-create` verbs. Every task the fake creates fails a
// moment later, as a worker failing would, so a careless automation on
// task-failed would loop forever. Each test imports a fresh copy of
// server.js (its store is module-resident across activations).
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { createMemoryStorage } from "../../scripts/memoryStorage.mjs";

type Json = Record<string, any>;
type Handler = (req: Json, res: Json) => void;

let copy = 0;

function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await check()) return resolve();
      if (Date.now() > until) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(poll, 20);
    };
    void poll();
  });
}

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

// A stand-in for agent-tasks' control socket. `created` is every task-create
// body it got, with the ids it answered.
function fakeAgentTasks(socketPath: string, { failCreated = true } = {}) {
  const subscribers = new Set<http.ServerResponse>();
  const created: Json[] = [];
  let n = 0;
  const emit = (event: Json) => {
    for (const res of subscribers) res.write(`${JSON.stringify({ ...event, at: Date.now() })}\n`);
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/subscribe") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(`${JSON.stringify({ type: "hello" })}\n`);
        subscribers.add(res);
        res.on("close", () => subscribers.delete(res));
        return;
      }
      if (req.url === "/task-create") {
        n += 1;
        const task = { taskId: `task_${n}`, runId: `run_${n}`, repo: body.repo, title: body.title };
        created.push({ ...body, ...task });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ taskId: task.taskId, runId: task.runId }));
        if (failCreated) setTimeout(() => emit({ type: "task-failed", ...task }), 20);
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "unknown verb" }));
    });
  });
  const listen = () => new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const close = () =>
    new Promise<void>((resolve) => {
      for (const res of subscribers) res.end();
      subscribers.clear();
      server.close(() => resolve());
    });
  return { emit, created, listen, close, subscribers };
}

async function harness({ settings = {}, seed, ai }: { settings?: Json; seed?: Json; ai?: (prompt: string, opts: Json) => Promise<string> } = {}) {
  const mem = createMemoryStorage();
  if (seed) await mem.storage.collection("state").put("main", seed);
  const socketDir = mem.storage.runtimeDirOf("perch.agent-tasks");
  mkdirSync(socketDir, { recursive: true });
  const socketPath = path.join(socketDir, "control.sock");
  let fake = fakeAgentTasks(socketPath);
  await fake.listen();

  const routes = new Map<string, Handler>();
  const router = {
    get: (p: string, h: Handler) => routes.set(`GET ${p}`, h),
    post: (p: string, h: Handler) => routes.set(`POST ${p}`, h),
  };
  const url = new URL("../server.js", import.meta.url);
  url.search = `?copy=${++copy}`;
  const server = await import(url.href);
  server.activate({
    router,
    log: () => {},
    getSettings: async () => settings,
    ai: { run: ai ?? (async () => "fine") },
    storage: mem.storage,
  });

  const call = (method: string, route: string, body: Json = {}, params: Json = {}): Promise<{ status: number; body: Json }> =>
    new Promise((resolve) => {
      const handler = routes.get(`${method} ${route}`);
      if (!handler) throw new Error(`no route ${method} ${route}`);
      const res = {
        headersSent: false,
        statusCode: 200,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(payload: Json) {
          this.headersSent = true;
          resolve({ status: this.statusCode, body: payload });
        },
      };
      handler({ method, originalUrl: route, body, params }, res);
    });
  const list = async () => (await call("GET", "/list")).body;
  const find = async (id: string) => (await list()).automations.find((a: Json) => a.id === id);
  const create = async (fields: Json) => (await call("POST", "/create", fields)).body.automation.id as string;
  const changes = () => mem.events.filter((e: Json) => e.type === "topic" && e.topic === "changed").length;
  const doc = async () => (await mem.storage.collection("state").get("main"))?.value as Json;

  await waitFor(async () => (await list()).agentTasks.connected, "the subscribe stream");
  return {
    mem,
    call,
    list,
    find,
    create,
    changes,
    doc,
    get fake() {
      return fake;
    },
    async restartFake() {
      fake = fakeAgentTasks(socketPath);
      await fake.listen();
    },
    async done() {
      server.deactivate();
      await fake.close().catch(() => {});
      rmSync(mem.root, { recursive: true, force: true });
    },
  };
}

const onFailure = (repo?: string) => ({ kind: "event", event: "task-failed", ...(repo ? { repo } : {}) });
const createTask = (prompt = "look into it") => ({ kind: "create-task", prompt });

test("an automation on task-failed that creates a failing task runs once", async () => {
  const h = await harness();
  try {
    const id = await h.create({ name: "Retry", trigger: onFailure(), action: createTask(), repo: "/r" });
    h.fake.emit({ type: "task-failed", taskId: "task_outside", runId: "run_outside", repo: "/r" });
    await waitFor(async () => (await h.find(id)).runs.length === 1, "the first run");
    await settle(); // the task it made fails 20ms later; that must not start it again
    const a = await h.find(id);
    assert.equal(h.fake.created.length, 1, "exactly one task created");
    assert.equal(a.runs.length, 1);
    assert.equal(a.runCount, 1);
    assert.equal(a.lastStatus, "ok");
    const origin = (await h.doc()).origins[h.fake.created[0].taskId];
    assert.equal(origin.automationId, id, "the task is tagged with the automation that made it");
    assert.equal(origin.depth, 1);
  } finally {
    await h.done();
  }
});

test("a three-automation chain stops at depth 3 with a note", async () => {
  const h = await harness();
  try {
    // A feeds B feeds C feeds A, through each other's repositories.
    const a = await h.create({ name: "A", trigger: onFailure("/r/c"), action: createTask(), repo: "/r/a" });
    const b = await h.create({ name: "B", trigger: onFailure("/r/a"), action: createTask(), repo: "/r/b" });
    const c = await h.create({ name: "C", trigger: onFailure("/r/b"), action: createTask(), repo: "/r/c" });
    h.fake.emit({ type: "task-failed", taskId: "task_outside", runId: "run_outside", repo: "/r/c" });
    await waitFor(async () => (await h.find(a)).runs.length === 2, "A to be stopped on the second lap");
    await settle();
    assert.equal(h.fake.created.length, 3, "A, B and C each created one task, then the chain ended");
    const [ra, rb, rc] = [await h.find(a), await h.find(b), await h.find(c)];
    assert.deepEqual(
      ra.runs.map((r: Json) => r.status),
      ["stopped", "ok"],
    );
    assert.match(ra.runs[0].result, /stopped: chain depth 3 reached/);
    assert.equal(ra.runCount, 1, "the stopped run is not counted as a run");
    assert.equal(rb.runs.length, 1);
    assert.equal(rc.runs.length, 1);
    const origins = (await h.doc()).origins;
    assert.deepEqual(
      h.fake.created.map((t: Json) => origins[t.taskId].depth),
      [1, 2, 3],
    );
  } finally {
    await h.done();
  }
});

test("a run starting and finishing, and Agent Tasks going and coming, are announced", async () => {
  let release: (reply: string) => void = () => {};
  const seen: Json[] = [];
  const h = await harness({
    settings: { "automations.aiModel": " fast-model " },
    ai: (_prompt, opts) => {
      seen.push(opts);
      return new Promise((resolve) => (release = resolve));
    },
  });
  try {
    const id = await h.create({ name: "Ask", trigger: { kind: "interval", minutes: 60 }, action: { kind: "headless", prompt: "hi" } });
    const before = h.changes();
    await h.call("POST", "/run/:id", {}, { id });
    await waitFor(() => h.changes() > before, "the start notice");
    assert.equal((await h.find(id)).running, true, "the panel's refetch sees it running");
    assert.equal(seen[0].timeoutMs, 10 * 60_000, "an AI run may take up to 10 minutes");
    assert.equal(seen[0].model, "fast-model", "automations.aiModel picks the model");

    const started = h.changes();
    release("the answer");
    await waitFor(() => h.changes() > started, "the finish notice");
    const done = await h.find(id);
    assert.equal(done.running, false);
    assert.equal(done.runs[0].result, "the answer");

    const up = h.changes();
    await h.fake.close();
    await waitFor(() => h.changes() > up, "the Agent Tasks gone notice");
    assert.equal((await h.list()).agentTasks.connected, false);

    const down = h.changes();
    await h.restartFake();
    await waitFor(() => h.changes() > down, "the Agent Tasks back notice");
    assert.equal((await h.list()).agentTasks.connected, true);
  } finally {
    await h.done();
  }
});

test("the last twenty runs are kept", async () => {
  let calls = 0;
  const h = await harness({ ai: async () => `reply ${++calls}` });
  try {
    const id = await h.create({ name: "Ask", trigger: { kind: "interval", minutes: 60 }, action: { kind: "headless", prompt: "hi" } });
    for (let i = 1; i <= 22; i++) {
      await h.call("POST", "/run/:id", {}, { id });
      await waitFor(async () => (await h.find(id)).runCount === i, `run ${i}`);
    }
    const a = await h.find(id);
    assert.equal(a.runs.length, 20);
    assert.equal(a.runs[0].result, "reply 22");
    assert.equal(a.runs[19].result, "reply 3");
    assert.equal(a.runCount, 22);
  } finally {
    await h.done();
  }
});

test("Pause All stops schedules and events, survives a restart, and resumes", async () => {
  const now = Date.now();
  const base = { enabled: true, repo: "", createdAt: now, updatedAt: now, lastRunAt: null, lastResult: "", lastStatus: null, runCount: 0 };
  let calls = 0;
  const h = await harness({
    ai: async () => `reply ${++calls}`,
    // Saved paused, with a schedule overdue by a second: the startup pass
    // would run it if Pause All weren't kept.
    seed: {
      version: 1,
      paused: true,
      origins: {},
      automations: {
        auto_sched: { ...base, id: "auto_sched", name: "Sched", trigger: { kind: "interval", minutes: 5 }, action: { kind: "headless", prompt: "hi" }, nextRunAt: now - 1_000 },
        auto_event: { ...base, id: "auto_event", name: "Event", trigger: onFailure(), action: { kind: "headless", prompt: "hi" }, nextRunAt: null },
      },
    },
  });
  try {
    assert.equal((await h.list()).paused, true, "paused is kept across a restart");
    const sched = await h.find("auto_sched");
    assert.equal(sched.runCount, 0, "the overdue schedule did not fire");
    assert.ok(sched.nextRunAt > now, "and was moved on, not saved up for the resume");

    h.fake.emit({ type: "task-failed", taskId: "task_x", runId: "run_x", repo: "" });
    await settle();
    assert.equal(calls, 0, "no event starts anything while paused");
    assert.equal((await h.find("auto_event")).runCount, 0);
    assert.equal((await h.call("POST", "/run/:id", {}, { id: "auto_event" })).status, 409, "Run now is refused while paused");
    await settle();
    assert.equal(calls, 0, "a refused Run now starts nothing");

    assert.equal((await h.call("POST", "/pause", { paused: false })).body.paused, false);
    assert.equal((await h.doc()).paused, false, "resuming is saved");
    h.fake.emit({ type: "task-failed", taskId: "task_y", runId: "run_y", repo: "" });
    await waitFor(async () => (await h.find("auto_event")).runCount === 1, "the event run after resuming");

    assert.equal((await h.call("POST", "/pause", { paused: true })).body.paused, true);
    assert.equal((await h.doc()).paused, true, "pausing is saved");
    assert.equal((await h.call("POST", "/pause", { paused: "yes" })).status, 400);
  } finally {
    await h.done();
  }
});
