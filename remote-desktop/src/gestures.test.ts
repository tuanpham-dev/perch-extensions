import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_KEYS, GESTURE_DEFAULTS, MODIFIER_CODES, actionButton, backButton, gain, normalizeGestures, stripKeys } from "./gestures.ts";

test("the defaults are the original gestures and strip", () => {
  const g = normalizeGestures(null);
  assert.deepEqual(g, GESTURE_DEFAULTS);
  assert.equal(g.longPress, "right");
  assert.equal(g.twoTap, "right");
  assert.equal(g.threeTap, "middle");
  assert.equal(g.fourTap, "keyboard");
  assert.equal(g.doubleTap, "none");
  assert.deepEqual(stripKeys(g).map((k) => k.label), ["Esc", "Tab", "Ctrl", "Alt", "Super", "←", "↑", "↓", "→", "Home", "End", "PgUp", "PgDn"]);
  assert.deepEqual([...MODIFIER_CODES].sort((a, b) => a - b), [29, 42, 56, 125]);
});

test("stored settings are checked: unknown keys and actions fall back", () => {
  const g = normalizeGestures({ keys: ["f5", "nope", "esc"], twoTap: "explode" as never, speed: 9, keyRows: 7, back: "right" });
  assert.deepEqual(g.keys, ["f5", "esc"]);
  assert.equal(g.twoTap, "right");
  assert.equal(g.speed, 1);
  assert.equal(g.keyRows, 1);
  assert.equal(backButton(g), 3);
  assert.deepEqual(normalizeGestures({ keys: [] }).keys, DEFAULT_KEYS);
});

test("acceleration: slow moves are finer, fast ones go farther, capped", () => {
  assert.equal(gain(0, true, 1), 0.5);
  assert.ok(gain(0.1, true, 1) < 1);
  assert.ok(gain(1, true, 1) > 2);
  assert.equal(gain(10, true, 1), 3);
  assert.equal(gain(10, false, 2), 2);
});

test("actions map to protocol buttons", () => {
  assert.equal(actionButton("left"), 1);
  assert.equal(actionButton("double"), 1);
  assert.equal(actionButton("middle"), 2);
  assert.equal(actionButton("right"), 3);
  assert.equal(actionButton("keyboard"), 0);
});
