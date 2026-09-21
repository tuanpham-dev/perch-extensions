import assert from "node:assert/strict";
import { test } from "node:test";
import { KEYS, cursorStepToward, isKeyName, letterKeyFor, nextKeyForChat, nextKeyForOption, typedText } from "../keys.mjs";

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

const question = (cursorN: number, multiSelect = false) => ({
  numbered: true,
  multiSelect,
  options: [
    { n: 1, label: "Red", cursor: cursorN === 1 },
    { n: 2, label: "Blue", cursor: cursorN === 2 },
    { n: 3, label: "Type something", cursor: cursorN === 3, textEntry: true, typed: "" },
    { n: 4, label: "Chat about this", cursor: cursorN === 4 },
  ],
});

test("with the cursor in the text field, an option first moves out of it", () => {
  assert.equal(nextKeyForOption(question(3), 4), "up");
  assert.equal(nextKeyForOption(question(3), 1), "up");
  assert.equal(nextKeyForOption(question(2), 4), "4");
});

test("the text field is reached by its digit, or is already there", () => {
  assert.equal(nextKeyForOption(question(1), 3), "3");
  assert.equal(nextKeyForOption(question(3), 3), "here");
});

test("a text field with something typed is reached with arrows: its digit would submit the text", () => {
  const typed = question(1);
  typed.options[2].typed = "old draft";
  assert.equal(nextKeyForOption(typed, 3), "down");
});

test("a multi-select text field is reached with arrows: its digit only ticks the box", () => {
  assert.equal(nextKeyForOption(question(1, true), 3), "down");
  assert.equal(nextKeyForOption(question(3, true), 3), "here");
});

test("a preview question leaves its Notes field and its Chat row before moving", () => {
  const preview = (over: Record<string, unknown>) => ({ ...question(1), options: question(1).options.slice(0, 2), notes: { text: "", editing: false }, chat: { cursor: false }, ...over });
  assert.equal(cursorStepToward(preview({}), 2), "down");
  assert.equal(cursorStepToward(preview({ notes: { text: "x", editing: true } }), 2), "esc");
  assert.equal(cursorStepToward(preview({ chat: { cursor: true } }), 1), "up");
  assert.equal(nextKeyForOption(preview({ notes: { text: "", editing: true } }), 2), "esc");
  assert.equal(nextKeyForChat(preview({})), "down");
  assert.equal(nextKeyForChat(preview({ chat: { cursor: true } })), "enter");
  assert.equal(nextKeyForChat(question(1)), null);
});

test("typed text goes in as keystrokes, never as a paste: a paste reaches the model tagged as pasted content", () => {
  assert.equal(typedText("plain words"), "plain words");
  assert.equal(typedText("\x1b[200~x\x1b[201~"), "x");
  // Each line break opens a line in the input box (Esc+Enter) instead of
  // submitting what is there; tabs go in as Claude Code's own four spaces.
  assert.equal(typedText("a\nb\r\nc"), "a\x1b\rb\x1b\rc");
  assert.equal(typedText("a\tb"), "a    b");
  // A prompt's one-line field takes the lines flattened: Esc leaves the prompt.
  assert.equal(typedText("a\nb", { newlines: "space" }), "a b");
  // Stray control bytes would act as keys (\x03 interrupts the turn).
  assert.equal(typedText("keep\x03this"), "keepthis");
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
