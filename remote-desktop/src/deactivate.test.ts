import assert from "node:assert/strict";
import http from "node:http";
import { it } from "node:test";
import { activate, deactivate } from "../server.js";

// A fake qr-host answering /status, owned by the extension's session in a
// fake host. Killing the session closes it, as the real host exits.
async function harness() {
  const qr = http.createServer((_req, res) => res.end(JSON.stringify({ viewers: 0, width: 1, height: 1 })));
  await new Promise<void>((r) => qr.listen(0, "127.0.0.1", r));
  const port = (qr.address() as { port: number }).port;
  const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const router = {
    get: (p: string, fn: never) => routes.set(`GET ${p}`, fn),
    post: (p: string, fn: never) => routes.set(`POST ${p}`, fn),
  };
  const killed: string[] = [];
  const host = {
    sessions: {
      list: async () => [{ name: "remote-desktop" }, { name: "work" }],
      kill: async (name: string) => {
        killed.push(name);
        qr.closeAllConnections();
        await new Promise((r) => qr.close(r));
      },
    },
    ports: { list: async () => [{ port, session: "remote-desktop" }] },
  };
  // The port setting points at the fake host too, so nothing else is probed.
  activate({ router, log: () => {}, getSettings: async () => ({ "remoteDesktop.port": port }), host });
  return { routes, killed, close: () => qr.listening && qr.close() };
}

function call(fn: (req: unknown, res: unknown) => Promise<void>, body: unknown) {
  return new Promise<unknown>((resolve) => {
    const res = { json: resolve, status: () => res };
    void fn({ body }, res);
  });
}

it("stops only its own session on deactivate, and only once it has one", async () => {
  let h = await harness();
  try {
    await deactivate();
    assert.deepEqual(h.killed, [], "nothing started or found: nothing stopped");
  } finally {
    h.close();
  }

  h = await harness();
  // Any request that looks at what's running finds the host left by an
  // earlier run (Launch, here: it touches no binary).
  await call(h.routes.get("POST /launch")!, { command: "true" });
  await deactivate();
  assert.deepEqual(h.killed, ["remote-desktop"]);
  // Already stopped: a second deactivate does nothing.
  await deactivate();
  assert.deepEqual(h.killed, ["remote-desktop"]);
});
