// The refresher around `claude -p /usage`: one run a minute, shared by
// whoever asks during it, and a failed or hung run costs nothing more than
// the minute's wait before the next try.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { ARGS, CLI, createRefresher } from "../readers/claudeCli.mjs";

class FakeChild extends EventEmitter {
  killed: string | null = null;
  kill(signal: string) {
    this.killed = signal;
  }
}

// A spawn that records its calls and hands each child back to the test to
// finish however it likes.
function fakeSpawn() {
  const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const children: FakeChild[] = [];
  const spawn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

const tickAsync = () => new Promise((r) => setImmediate(r));

describe("createRefresher", () => {
  it("runs the CLI with print mode, no transcript and no MCP servers, in the given folder", async () => {
    const { spawn, calls, children } = fakeSpawn();
    const c = clock();
    const r = createRefresher({ spawn: spawn as never, now: c.now, cwd: "/home/someone" });
    const p = r.refresh();
    await tickAsync();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, CLI);
    assert.deepEqual(calls[0].args, ARGS);
    assert.deepEqual(calls[0].args.slice(0, 2), ["-p", "/usage"]);
    assert.ok(calls[0].args.includes("--no-session-persistence"));
    assert.equal(calls[0].opts.cwd, "/home/someone");
    assert.equal(calls[0].opts.stdio, "ignore");
    children[0].emit("exit", 0);
    assert.equal(await p, true);
  });

  it("runs once a minute, and answers from the last run in between", async () => {
    const { spawn, calls, children } = fakeSpawn();
    const c = clock();
    const r = createRefresher({ spawn: spawn as never, now: c.now, intervalMs: 60_000 });
    const first = r.refresh();
    children[0].emit("exit", 0);
    assert.equal(await first, true);
    c.tick(59_000);
    assert.equal(await r.refresh(), true);
    assert.equal(calls.length, 1);
    c.tick(1_000);
    const second = r.refresh();
    assert.equal(calls.length, 2);
    children[1].emit("exit", 0);
    assert.equal(await second, true);
    assert.equal(r.runs, 2);
  });

  it("lets concurrent callers share one run", async () => {
    const { spawn, calls, children } = fakeSpawn();
    const r = createRefresher({ spawn: spawn as never, now: clock().now });
    const a = r.refresh();
    const b = r.refresh();
    assert.equal(calls.length, 1);
    children[0].emit("exit", 0);
    assert.deepEqual(await Promise.all([a, b]), [true, true]);
  });

  it("reports a CLI that isn't there, and doesn't try again inside the minute", async () => {
    const { spawn, calls, children } = fakeSpawn();
    const c = clock();
    const r = createRefresher({ spawn: spawn as never, now: c.now });
    const p = r.refresh();
    children[0].emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
    assert.equal(await p, false);
    c.tick(30_000);
    assert.equal(await r.refresh(), false);
    assert.equal(calls.length, 1);
    c.tick(30_000);
    r.refresh();
    assert.equal(calls.length, 2);
  });

  it("counts a non-zero exit as a failed run", async () => {
    const { spawn, children } = fakeSpawn();
    const r = createRefresher({ spawn: spawn as never, now: clock().now });
    const p = r.refresh();
    children[0].emit("exit", 1);
    assert.equal(await p, false);
  });

  it("kills a run that outlives the timeout and moves on", async () => {
    const { spawn, children } = fakeSpawn();
    const r = createRefresher({ spawn: spawn as never, now: clock().now, timeoutMs: 20 });
    const p = r.refresh();
    assert.equal(await p, false);
    assert.equal(children[0].killed, "SIGKILL");
    // The late exit of a killed child changes nothing.
    children[0].emit("exit", null);
    assert.equal(await r.refresh(), false);
  });

  it("survives a spawn that throws", async () => {
    const spawn = () => {
      throw new Error("EAGAIN");
    };
    const r = createRefresher({ spawn: spawn as never, now: clock().now });
    assert.equal(await r.refresh(), false);
  });
});
