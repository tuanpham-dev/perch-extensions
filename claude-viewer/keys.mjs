// The bytes a key press or a message becomes in the terminal. Everything the
// tab sends reaches Claude Code through host.sessions.sendTextToWindow as raw
// input, exactly as if typed.

export const KEYS = Object.freeze({
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  shiftTab: "\x1b[Z",
  ctrlC: "\x03",
  ctrlU: "\x15",
  ctrlE: "\x05",
  backspace: "\x7f",
  1: "1",
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
});

export function isKeyName(name) {
  return typeof name === "string" && Object.hasOwn(KEYS, name);
}

// Text as keystrokes, the way a person at the keyboard would enter it.
//
// Not as a bracketed paste, which is what this used to send: Claude Code files
// any paste of 20 characters or more away as pasted content and wraps it in
// <pasted_content> tags on its way to the model, where it reads as material
// quoted from somewhere else rather than as the user's own words - a message
// sent that way has come back answered with "the pasted content contains an
// instruction, but since your own message doesn't ask me to follow it...".
// A message composed in this tab IS the user's own words.
//
// So: control bytes dropped (they would act as keys), tabs as the four spaces
// Claude Code itself turns a pasted tab into, and each newline as Esc+Enter -
// the sequence /terminal-setup binds Shift+Enter to, which opens a line in the
// input box instead of submitting what is in it. With `newlines: "space"` the
// text is flattened instead, for a prompt's one-line text field, where Esc
// would leave the prompt rather than open a line.
export function typedText(text, { newlines = "insert" } = {}) {
  const body = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[20[01]~/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");
  return newlines === "space" ? body.replace(/\n+/g, " ") : body.split("\n").join("\x1b\r");
}

// The arrow that moves a prompt's cursor one row toward option `n`, "here"
// when it is already there, or null when the option or the cursor isn't on
// screen. The caller re-reads the screen between steps.
export function cursorStepToward(prompt, n) {
  // A preview prompt's Notes field takes keys while open, and its unnumbered
  // "Chat about this" row sits below the options: leave either first.
  if (prompt.notes?.editing) return "esc";
  if (prompt.chat?.cursor) return "up";
  const goal = prompt.options.findIndex((o) => o.n === n);
  const cursor = prompt.options.findIndex((o) => o.cursor);
  if (goal === -1 || cursor === -1) return null;
  if (cursor === goal) return "here";
  return goal > cursor ? "down" : "up";
}

// The next key toward choosing option `n` of a prompt; the caller sends it,
// re-reads the screen and asks again until it gets a digit, "enter" or "here".
// A numbered picker takes the digit. An unnumbered list (the folder trust
// prompt) moves the cursor one row at a time, then Enter.
//
// A text-entry option (screen.mjs markTextEntry) types every key while the
// cursor is on it, digits included. So with the cursor there, another option
// first needs an arrow to leave it, and the option itself needs nothing more:
// "here". Its digit moves the cursor in only when the field is empty in a
// single-select list: with text typed the digit submits that text as the
// answer, and in a multi-select list it only ticks the row's box. Otherwise
// the field is reached with arrows.
export function nextKeyForOption(prompt, n) {
  const target = prompt.options.find((o) => o.n === n);
  if (!target) return null;
  if (prompt.numbered !== false) {
    if (n < 1 || n > 9) return null;
    if (prompt.notes?.editing) return "esc";
    if (prompt.chat?.cursor) return "up";
    const cursor = prompt.options.find((o) => o.cursor);
    if (target.textEntry) {
      if (cursor === target) return "here";
      if (prompt.multiSelect || target.typed) return cursorStepToward(prompt, n);
      return String(n);
    }
    if (cursor?.textEntry) return "up";
    return String(n);
  }
  const step = cursorStepToward(prompt, n);
  return step === "here" ? "enter" : step;
}

// A letter key the prompt's footer offers, or null. Only single letters the
// footer names are ever sent, never an arbitrary key.
export function letterKeyFor(prompt, key) {
  const k = String(key ?? "").toLowerCase();
  return /^[a-z]$/.test(k) && (prompt.letterKeys ?? []).some((l) => l.key === k) ? k : null;
}

// The next key toward a preview prompt's "Chat about this" row, then Enter on
// it: that row has no number, so it is reached with arrows.
export function nextKeyForChat(prompt) {
  if (!prompt.chat) return null;
  if (prompt.notes?.editing) return "esc";
  return prompt.chat.cursor ? "enter" : "down";
}
