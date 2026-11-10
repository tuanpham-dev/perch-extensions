import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { activate } from "../server.js";

// Two rpc-hosts of the same version: an older build (a machine's own host
// service installed before the browser gateway) and a current one. The
// older one must be passed over with why, never started to fail.
function fakeHost(dir: string, name: string, help: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = --version ]; then echo "rpc-host 0.2.0"; exit 0; fi\nif [ "$1" = run ]; then echo "${help}"; exit 0; fi\nexit 2\n`);
  chmodSync(p, 0o755);
  return p;
}

it("passes over an older rpc-host build and says what it lacks", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rd-engine-"));
  try {
    const old = fakeHost(dir, "old", "Usage: rpc-host run [OPTIONS] --listen --source");
    const current = fakeHost(dir, "current", "Usage: rpc-host run [OPTIONS] --ws-listen --follower-fps --attach --stop-ends-sessions");
    let serverPath = old;
    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    const router = { get: (p: string, fn: never) => routes.set(`GET ${p}`, fn), post: (p: string, fn: never) => routes.set(`POST ${p}`, fn) };
    const host = { sessions: { list: async () => [], kill: async () => {} }, ports: { list: async () => [] } };
    activate({ router, log: () => {}, getSettings: async () => ({ "remoteDesktop.serverPath": serverPath }), host });
    const call = (key: string) =>
      new Promise<{ code: number; body: Record<string, unknown> }>((resolve) => {
        let code = 200;
        const res = { status: (c: number) => ((code = c), res), json: (body: Record<string, unknown>) => resolve({ code, body }) };
        void routes.get(key)!({ body: {} }, res);
      });

    let s = (await call("GET /status")).body;
    assert.equal(s.installed, false);
    assert.equal(s.serverReason, "old-build");
    assert.deepEqual(s.lacking, ["--ws-listen", "--follower-fps", "--attach", "--stop-ends-sessions"]);
    // Start refuses at once, naming the build and what it lacks.
    const started = await call("POST /start");
    assert.equal(started.code, 400);
    assert.match(String(started.body.error), /older rpc-host build \(it lacks --ws-listen/);

    serverPath = current;
    s = (await call("GET /status")).body;
    assert.equal(s.installed, true);
    assert.equal(s.serverPath, current);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
