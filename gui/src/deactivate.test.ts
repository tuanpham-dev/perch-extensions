import assert from "node:assert/strict";
import net from "node:net";
import { it } from "node:test";
import { activate, deactivate } from "../server.js";

// A router that only records handlers, and a host whose gui-apps session
// owns a port that really answers.
function harness(port: number) {
  const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  const router = {
    get: (p: string, fn: never) => routes.set(`GET ${p}`, fn),
    post: (p: string, fn: never) => routes.set(`POST ${p}`, fn),
  };
  const killed: string[] = [];
  const host = {
    sessions: {
      list: async () => [{ name: "gui-apps" }, { name: "work" }],
      kill: async (name: string) => void killed.push(name),
    },
    ports: { list: async () => [{ port, session: "gui-apps" }] },
  };
  activate({ router, log: () => {}, getSettings: async () => ({}), host });
  return { routes, killed };
}

function call(fn: (req: unknown, res: unknown) => Promise<void>) {
  return new Promise<unknown>((resolve) => {
    const res = { json: resolve, status: () => res };
    void fn({}, res);
  });
}

it("stops only its own session on deactivate, and only once it has one", async () => {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as net.AddressInfo).port;
  try {
    // Nothing started or found yet: deactivate leaves every session alone.
    let h = harness(port);
    await deactivate();
    assert.deepEqual(h.killed, []);

    // A display found running (left by an earlier run) is this extension's.
    h = harness(port);
    const status = (await call(h.routes.get("GET /status")!)) as { running: boolean };
    assert.equal(status.running, true);
    await deactivate();
    assert.deepEqual(h.killed, ["gui-apps"]);
  } finally {
    server.close();
  }
});
