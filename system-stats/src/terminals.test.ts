// Per-terminal figures follow session events: each window's shell pid is
// looked up once and again only when windows open or close, not by asking
// every session for its panes on every poll.
import assert from "node:assert/strict";
import { test } from "node:test";

const server = await import("../server.js");

let windows = [{ id: "w-1", index: 0, name: "shell", command: "zsh" }];
let listPanesCalls = 0;
let onChange: (() => void) | null = null;
const host = {
  sessions: {
    list: async () => [{ name: "s", path: "/work/app", windows }],
    listPanes: async () => {
      listPanesCalls++;
      return windows.map((w) => ({ id: w.id, windowIndex: w.index, pid: process.pid, title: w.name, command: w.command }));
    },
    onChange(cb: () => void) {
      onChange = cb;
      return () => {};
    },
  },
};
server.activate({ router: { get: () => {} }, host });

test("the window list is read once, then again only after a session change", async (t) => {
  const first = await server.readTerminals(host);
  if (!first.supported) {
    t.skip("no process table on this host");
    return;
  }
  assert.deepEqual(first.rows.map((r: { windowName: string }) => r.windowName), ["shell"]);
  assert.equal(listPanesCalls, 1);
  await server.readTerminals(host);
  await server.readTerminals(host);
  assert.equal(listPanesCalls, 1, "polls reuse the pids");

  // A renamed window shows its new name without a re-read: names come from the listing.
  windows = [{ ...windows[0], name: "renamed" }];
  assert.equal((await server.readTerminals(host)).rows[0].windowName, "renamed");
  assert.equal(listPanesCalls, 1);

  // A session change drops the pids.
  assert.ok(onChange, "subscribed to host.sessions.onChange");
  onChange!();
  await server.readTerminals(host);
  assert.equal(listPanesCalls, 2);

  // A window the pids have never seen is read before the change event arrives.
  windows = [...windows, { id: "w-2", index: 1, name: "second", command: "zsh" }];
  const rows = (await server.readTerminals(host)).rows;
  assert.equal(listPanesCalls, 3);
  assert.deepEqual(rows.map((r: { windowName: string }) => r.windowName).sort(), ["renamed", "second"]);
});
