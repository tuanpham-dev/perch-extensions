import assert from "node:assert/strict";
import { test } from "node:test";
import { KEYS, bracketedPaste, cursorStepToward, isKeyName, letterKeyFor, nextKeyForOption } from "../keys.mjs";

const numbered = {
  numbered: true,
  options: [
    { n: 1, label: "Yes", cursor: true },
    { n: 2, label: "No", cursor: false },
  ],
};
const unnumbered = {
  numbered: false,
  options: [
    { n: 1, label: "No, exit", cursor: true },
    { n: 2, label: "Yes, I trust this folder", cursor: false },
  ],
};

test("numbered options answer with their digit", () => {
  assert.equal(nextKeyForOption(numbered, 2), "2");
});

test("an option that isn't shown gets no key", () => {
  assert.equal(nextKeyForOption(numbered, 7), null);
});

test("unnumbered lists move the cursor toward the target", () => {
  assert.equal(nextKeyForOption(unnumbered, 2), "down");
  const onSecond = { ...unnumbered, options: unnumbered.options.map((o) => ({ ...o, cursor: o.n === 2 })) };
  assert.equal(nextKeyForOption(onSecond, 1), "up");
  assert.equal(nextKeyForOption(onSecond, 2), "enter");
});

test("bracketed paste wraps text and strips embedded paste markers", () => {
  assert.equal(bracketedPaste("a\nb"), "\x1b[200~a\nb\x1b[201~");
  assert.equal(bracketedPaste("x\x1b[201~y"), "\x1b[200~xy\x1b[201~");
});

test("key names", () => {
  assert.equal(KEYS.shiftTab, "\x1b[Z");
  assert.equal(isKeyName("esc"), true);
  assert.equal(isKeyName("constructor"), false);
  assert.equal(isKeyName("rm -rf"), false);
});

test("cursor steps toward an option in a numbered list too", () => {
  const picker = {
    numbered: true,
    options: [
      { n: 3, label: "Fable", cursor: false },
      { n: 4, label: "Sonnet", cursor: false },
      { n: 6, label: "Opus", cursor: true },
    ],
  };
  assert.equal(cursorStepToward(picker, 4), "up");
  assert.equal(cursorStepToward(picker, 6), "here");
  assert.equal(cursorStepToward(picker, 1), null);
});

test("only letter keys the footer offers are allowed", () => {
  const picker = { letterKeys: [{ key: "s", label: "use this session only" }] };
  assert.equal(letterKeyFor(picker, "s"), "s");
  assert.equal(letterKeyFor(picker, "S"), "s");
  assert.equal(letterKeyFor(picker, "x"), null);
  assert.equal(letterKeyFor(picker, "ss"), null);
  assert.equal(letterKeyFor({}, "s"), null);
});
