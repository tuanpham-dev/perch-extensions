// What "is an agent working" answers: a turn runs from prompt-submit to stop
// (or a permission prompt), a closed terminal or a very old turn ends it, and
// "agent" mode stays awake for 30 minutes after the last one ends.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AFTER_AGENTS_MS, STALE_MS, createActivity, wantsAwake } from "../activity.mjs";

const event = (kind: string, paneId: string, at: number, ours = true) => ({
  event: kind,
  paneId,
  sessionName: ours ? "s" : null,
  receivedAt: at,
});

describe("createActivity", () => {
  it("follows turns from prompt to stop, and how long ago the last one ended", () => {
    const a = createActivity();
    const open = new Set(["w1", "w2"]);
    assert.deepEqual(a.read(1000, open), { working: 0, idleForMs: null });
    a.onEvent(event("prompt-submit", "w1", 1000));
    a.onEvent(event("prompt-submit", "w2", 1100));
    assert.deepEqual(a.read(2000, open), { working: 2, idleForMs: null });
    a.onEvent(event("stop", "w1", 3000));
    assert.deepEqual(a.read(3500, open), { working: 1, idleForMs: null });
    a.onEvent(event("permission", "w2", 4000));
    assert.deepEqual(a.read(10_000, open), { working: 0, idleForMs: 6000 });
  });

  it("ends a turn whose terminal closed, but not one in a terminal it can't see", () => {
    const a = createActivity();
    a.onEvent(event("prompt-submit", "w3", 0));
    a.onEvent(event("prompt-submit", "elsewhere", 0, false));
    assert.equal(a.read(1000, new Set(["w3"])).working, 2);
    assert.equal(a.read(2000, new Set()).working, 1);
    assert.equal(a.read(3000, null).working, 1, "an unreadable window list ends nothing");
  });

  it("gives up on a turn that never stopped", () => {
    const a = createActivity();
    a.onEvent(event("prompt-submit", "w4", 0));
    assert.equal(a.read(STALE_MS, new Set(["w4"])).working, 1);
    assert.deepEqual(a.read(STALE_MS + 60_000, new Set(["w4"])), { working: 0, idleForMs: 60_000 });
  });
});

describe("wantsAwake", () => {
  it("is always for on, never for off, and while working plus 30 minutes for agent", () => {
    assert.equal(wantsAwake("on", { working: 0, idleForMs: null }), true);
    assert.equal(wantsAwake("off", { working: 3, idleForMs: null }), false);
    assert.equal(wantsAwake("agent", { working: 1, idleForMs: null }), true);
    assert.equal(wantsAwake("agent", { working: 0, idleForMs: null }), false, "no agent has run");
    assert.equal(wantsAwake("agent", { working: 0, idleForMs: AFTER_AGENTS_MS - 1 }), true);
    assert.equal(wantsAwake("agent", { working: 0, idleForMs: AFTER_AGENTS_MS }), false);
  });
});
