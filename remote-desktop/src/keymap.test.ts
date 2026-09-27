import { test } from "node:test";
import assert from "node:assert/strict";
import { codeToEvdev, evdevForCode } from "./keymap.ts";

test("common keys map to their evdev codes", () => {
  const expected: Record<string, number> = {
    Escape: 1, Digit1: 2, Digit0: 11, Minus: 12, Backspace: 14, Tab: 15, KeyQ: 16, Enter: 28, ControlLeft: 29,
    KeyA: 30, ShiftLeft: 42, KeyZ: 44, Comma: 51, Space: 57, F1: 59, F12: 88, NumpadEnter: 96, ArrowUp: 103,
    Delete: 111, MetaLeft: 125, ContextMenu: 127, IntlBackslash: 86, F24: 194,
  };
  for (const [code, value] of Object.entries(expected)) {
    assert.equal(evdevForCode(code), value, code);
  }
});

test("unknown codes are undefined and values are unique", () => {
  assert.equal(evdevForCode("Fn"), undefined);
  assert.equal(evdevForCode(""), undefined);
  const values = Object.values(codeToEvdev);
  assert.equal(new Set(values).size, values.length, "no two codes share an evdev value");
  assert.ok(values.every((v) => Number.isInteger(v) && v > 0 && v < 256));
});
