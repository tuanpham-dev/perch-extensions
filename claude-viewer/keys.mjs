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

// Text as one paste: Claude Code's input treats a bracketed paste as literal
// text, so newlines in it stay newlines instead of submitting early.
export function bracketedPaste(text) {
  return `\x1b[200~${String(text).replace(/\x1b\[20[01]~/g, "")}\x1b[201~`;
}

// The arrow that moves a prompt's cursor one row toward option `n`, "here"
// when it is already there, or null when the option or the cursor isn't on
// screen. The caller re-reads the screen between steps.
export function cursorStepToward(prompt, n) {
  const goal = prompt.options.findIndex((o) => o.n === n);
  const cursor = prompt.options.findIndex((o) => o.cursor);
  if (goal === -1 || cursor === -1) return null;
  if (cursor === goal) return "here";
  return goal > cursor ? "down" : "up";
}

// The keys that choose option `n` of a prompt. A numbered picker takes the
// digit. An unnumbered list (the folder trust prompt) moves the cursor one row
// at a time and presses Enter once it is on the target, so this returns just
// the next move, or "enter" when the cursor is already there.
export function nextKeyForOption(prompt, n) {
  const target = prompt.options.find((o) => o.n === n);
  if (!target) return null;
  if (prompt.numbered !== false) {
    if (n < 1 || n > 9) return null;
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
