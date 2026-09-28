// The phone keyboard: a hidden text field the Keyboard button focuses (a
// phone opens its keyboard only for a focused field), whose committed text
// goes out as `text` messages the server types character by character, and
// a strip of the keys a phone keyboard lacks, with sticky modifiers.
//
// The field always holds one sentinel space before the caret, so a
// Backspace has something to delete (keyboards send none into an empty
// field); after every edit the difference is sent and the field reset.
//
// Ported from QuicDesk's own web viewer (web/src/keyboard.ts). The page
// layout is Perch's here: the app already sizes itself to the visual
// viewport while a phone keyboard is up, so this module only reports the
// open state and never styles the document.
import { evdevForCode } from "./keymap";
import { chunkText, type ClientMsg } from "./wire";

const SENTINEL = " ";
// The visual viewport is this much shorter than the window while a phone
// keyboard is up.
const KEYBOARD_MIN_PX = 100;

const EVDEV = { backspace: 14 };
// Sticky modifiers on the strip, by evdev code.
const STICKY = new Set([29, 56, 125]);

/** The strip's keys, in order: evdev code and label. */
export const EXTRA_KEYS: { code: number; label: string; title?: string }[] = [
  { code: 1, label: "Esc" },
  { code: 15, label: "Tab" },
  { code: 29, label: "Ctrl" },
  { code: 56, label: "Alt" },
  { code: 125, label: "Super" },
  { code: 105, label: "←", title: "Left" },
  { code: 103, label: "↑", title: "Up" },
  { code: 108, label: "↓", title: "Down" },
  { code: 106, label: "→", title: "Right" },
  { code: 102, label: "Home" },
  { code: 107, label: "End" },
  { code: 104, label: "PgUp" },
  { code: 109, label: "PgDn" },
];

export const isStickyKey = (code: number) => STICKY.has(code);

export const isTouchDevice = () => window.matchMedia("(pointer: coarse)").matches;

export interface PhoneKeyboard {
  /** The field has focus: the phone keyboard is (or is coming) up. */
  isOpen(): boolean;
  /** Open the phone keyboard, or close it when it is open. */
  toggle(): void;
  /** A strip key was tapped: a sticky modifier arms or disarms, anything
   * else is sent with the armed modifiers. */
  tapStripKey(code: number): void;
  detach(): void;
}

export interface PhoneKeyboardOptions {
  field: HTMLTextAreaElement;
  send(msg: ClientMsg): void;
  /** The field gained or lost focus. */
  onOpenChange(open: boolean): void;
  /** The armed sticky modifiers changed. */
  onArmedChange(armed: ReadonlySet<number>): void;
}

export function attachPhoneKeyboard(opts: PhoneKeyboardOptions): PhoneKeyboard {
  const { field, send } = opts;
  const armed = new Set<number>();
  let composing = false;
  let sawKeyboard = false;
  // A chord typed while the phone keyboard was composing a word: the
  // character already sent, so the IME's late commit of it is not typed a
  // second time.
  let chordFromComposition: string | null = null;

  const isOpen = () => document.activeElement === field;

  const reset = () => {
    field.value = SENTINEL;
    field.setSelectionRange(SENTINEL.length, SENTINEL.length);
  };

  const setArmed = (update: () => void) => {
    update();
    opts.onArmedChange(new Set(armed));
  };

  // Run `action` inside the armed modifiers (and any held on a hardware
  // keyboard), then release them: a sticky modifier lasts one key.
  const withModifiers = (extra: number[], action: () => void) => {
    const mods = [...new Set([...armed, ...extra])];
    for (const code of mods) send({ t: "key", code, down: true });
    action();
    for (const code of mods.reverse()) send({ t: "key", code, down: false });
    if (armed.size) setArmed(() => armed.clear());
  };

  const tapKey = (code: number, extra: number[] = []) =>
    withModifiers(extra, () => {
      send({ t: "key", code, down: true });
      send({ t: "key", code, down: false });
    });

  const sendText = (text: string) => {
    if (!text) return;
    if (armed.size) {
      // The modifiers go with the first character only.
      const [first, ...rest] = Array.from(text);
      withModifiers([], () => send({ t: "text", text: first }));
      text = rest.join("");
    }
    for (const chunk of chunkText(text)) send({ t: "text", text: chunk });
  };

  // What the field gained or lost since the last reset.
  const flush = () => {
    if (composing) return;
    const value = field.value;
    if (value.startsWith(SENTINEL)) {
      sendText(value.slice(SENTINEL.length));
    } else {
      // The sentinel went: one Backspace (a selection delete counts as one).
      tapKey(EVDEV.backspace);
      sendText(value);
    }
    reset();
  };

  const modifiersHeld = (e: KeyboardEvent) =>
    [e.ctrlKey && 29, e.altKey && 56, e.metaKey && 125].filter((c): c is number => typeof c === "number");

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || composing || e.keyCode === 229) return;
    // Keys that edit or move rather than type (Enter, Backspace, arrows,
    // Escape, Tab, ...) go as keys; phone keyboards leave `code` empty,
    // so the key name decides.
    const named = e.key.length > 1 ? evdevForCode(e.key) : undefined;
    const chord = e.key.length === 1 && (e.ctrlKey || e.altKey || e.metaKey) ? evdevForCode(e.code) : undefined;
    const code = named ?? chord;
    if (code === undefined) return;
    e.preventDefault();
    tapKey(code, modifiersHeld(e));
  };
  // Phone keyboards (Gboard, SwiftKey) hold letters in a composing word
  // until a space or a suggestion commits it. A chord cannot wait for that:
  // with a modifier armed, the first character typed goes out at once with
  // the modifiers, and the field is reset, which ends the IME's word.
  const onInput = () => {
    if (!composing) {
      flush();
      return;
    }
    if (!armed.size) return;
    const value = field.value;
    const typed = value.startsWith(SENTINEL) ? value.slice(SENTINEL.length) : value;
    const first = Array.from(typed)[0];
    if (!first) return;
    withModifiers([], () => send({ t: "text", text: first }));
    chordFromComposition = first;
    reset();
  };
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
    // The committed text is in the field once the event has run.
    window.setTimeout(() => {
      const chord = chordFromComposition;
      chordFromComposition = null;
      if (chord !== null && field.value.startsWith(SENTINEL + chord)) {
        // The IME committed the word the chord cut short: drop the
        // character already sent, keep anything typed after it.
        field.value = SENTINEL + field.value.slice(SENTINEL.length + chord.length);
      }
      flush();
    }, 0);
  };
  const onFocus = () => {
    reset();
    sawKeyboard = false;
    opts.onOpenChange(true);
  };
  const onBlur = () => {
    composing = false;
    chordFromComposition = null;
    if (armed.size) setArmed(() => armed.clear());
    opts.onOpenChange(false);
  };

  field.addEventListener("keydown", onKeyDown);
  // A paste into the field arrives as an input like any other.
  field.addEventListener("input", onInput);
  field.addEventListener("compositionstart", onCompositionStart);
  field.addEventListener("compositionend", onCompositionEnd);
  field.addEventListener("focus", onFocus);
  field.addEventListener("blur", onBlur);

  // The phone closed its keyboard itself (back button, swipe) while the
  // field kept focus: close ours too, so the strip goes and the desktop
  // follows the tab's size again.
  const vv = window.visualViewport;
  const onViewport = () => {
    if (!isOpen() || !vv) return;
    const keyboardUp = window.innerHeight - vv.height * vv.scale > KEYBOARD_MIN_PX;
    if (keyboardUp) sawKeyboard = true;
    else if (sawKeyboard) field.blur();
  };
  vv?.addEventListener("resize", onViewport);

  return {
    isOpen,
    toggle() {
      if (isOpen()) field.blur();
      else field.focus({ preventScroll: true });
    },
    tapStripKey(code: number) {
      if (STICKY.has(code)) setArmed(() => (armed.has(code) ? armed.delete(code) : armed.add(code)));
      else tapKey(code);
    },
    detach() {
      field.removeEventListener("keydown", onKeyDown);
      field.removeEventListener("input", onInput);
      field.removeEventListener("compositionstart", onCompositionStart);
      field.removeEventListener("compositionend", onCompositionEnd);
      field.removeEventListener("focus", onFocus);
      field.removeEventListener("blur", onBlur);
      vv?.removeEventListener("resize", onViewport);
      if (isOpen()) field.blur();
    },
  };
}
