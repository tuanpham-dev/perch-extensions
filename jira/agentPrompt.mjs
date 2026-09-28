// Answering an agent's permission prompt from the board.
//
// The screen is read with the vendored Claude Viewer parser; an answer is
// only sent while the same prompt (by its signature) is still showing, so a
// click on a prompt that has since changed does nothing rather than choosing
// something in whatever replaced it. `capture` and `send` are passed in, so
// the batch and review runners share this and the tests drive it with fakes.
import { KEYS, isKeyName, nextKeyForOption } from "./vendor/claude-keys.mjs";
import { parseScreen } from "./vendor/claude-screen.mjs";

const MAX_STEPS = 6;
const AFTER_KEY_MS = 150;

// What the board needs of a prompt: its options by number, and the
// signature an answer has to match. Null when nothing prompt-like is showing
// or it cannot be read.
export function promptOf(screenText) {
  let parsed;
  try {
    parsed = parseScreen(String(screenText ?? ""));
  } catch {
    return null;
  }
  const prompt = parsed?.prompt;
  if (!prompt || !Array.isArray(prompt.options) || prompt.options.length === 0) return null;
  return {
    signature: prompt.signature,
    kind: prompt.kind ?? "generic",
    title: String(prompt.title ?? ""),
    question: String(prompt.question ?? ""),
    options: prompt.options.map((option) => ({ n: option.n, label: String(option.label ?? "") })),
  };
}

// Keys a button may send when the prompt can't be read.
export const FALLBACK_KEYS = ["1", "2", "3", "enter", "esc"];

// action: { type: "option", n } | { type: "key", key } | { type: "text", text }
// Returns { ok, error? }.
export async function answerPrompt({ capture, send, typed, action, expect = "", sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const read = async () => {
    const text = await capture();
    return { text, parsed: (() => { try { return parseScreen(text); } catch { return null; } })() };
  };
  let { parsed } = await read();
  const prompt = parsed?.prompt ?? null;
  if (expect && prompt?.signature !== expect) return { ok: false, error: "The prompt changed - look again before answering" };

  if (action?.type === "key") {
    const key = String(action.key ?? "");
    if (!FALLBACK_KEYS.includes(key) || !isKeyName(key)) return { ok: false, error: `"${key}" is not a key the board sends` };
    await send(KEYS[key], false);
    return { ok: true };
  }
  if (action?.type === "text") {
    const text = String(action.text ?? "").trim();
    if (!text) return { ok: false, error: "nothing to send" };
    await send(typed(text), true);
    return { ok: true };
  }
  if (action?.type === "option") {
    const n = Number(action.n);
    if (!prompt) return { ok: false, error: "No prompt on screen" };
    let current = prompt;
    for (let step = 0; step < MAX_STEPS; step++) {
      if (expect && current.signature !== expect) break;
      const key = nextKeyForOption(current, n);
      if (!key) return { ok: false, error: `Option ${n} is not on screen` };
      if (key === "here") return { ok: true };
      await send(KEYS[key], false);
      if (key === "enter" || /^[1-9]$/.test(key)) return { ok: true };
      await sleep(AFTER_KEY_MS);
      ({ parsed } = await read());
      current = parsed?.prompt;
      if (!current) return { ok: false, error: "The prompt went away" };
    }
    return { ok: false, error: "Could not reach that option" };
  }
  return { ok: false, error: "unknown action" };
}

// A message as typed at the keyboard rather than pasted, for Claude Code:
// it files any paste of 20 characters or more away as <pasted_content> and
// tells the model it is quoted material, so an instruction sent that way was
// read as something to consider rather than something to do. Control bytes
// are dropped (they would act as keys), tabs become spaces, and each newline
// is Esc+Enter, which opens a line in its input box instead of submitting.
//
// Only for Claude Code: in other agents' composers Esc may interrupt, so
// they keep the bracketed paste.
export function typedText(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .split("\n")
    .join("\x1b\r");
}

