// This extension's own settings, and live updates for them.
//
// Viewers are registered by class rather than constructed with ctx, so they
// reach settings the same way they reach the host: through this module, wired
// once at activation. `onDidChange` fires for edits made in Settings or on
// another device, so an open editor re-applies without a reload.
export type MinimapMode = "auto" | "on" | "off";
export type LineNumbersMode = "auto" | "on" | "relative" | "off";

interface SettingsApi {
  get(key: string): unknown;
  /** Absent in tests; the host always provides it. */
  set?(key: string, value: unknown): void;
  onDidChange(cb: () => void): () => void;
}

let api: SettingsApi | null = null;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

export function setSettingsApi(next: SettingsApi): void {
  api = next;
  unsubscribe = next.onDidChange(() => {
    for (const listener of [...listeners]) listener();
  });
}

export function clearSettingsApi(): void {
  unsubscribe?.();
  unsubscribe = null;
  listeners.clear();
  api = null;
}

/** Subscribe to any settings change; returns an unsubscribe function. */
export function onSettingsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Whether the editor should run vim keybindings. */
export function vimEnabled(): boolean {
  return api?.get("textEditor.vim") === true;
}

/**
 * Parses a Ctrl-chord list setting (`textEditor.vimEditorKeys`,
 * `textEditor.vimKeys`) into the key names monaco-vim hands its keymap
 * (`Ctrl-c`, `Shift-Ctrl-z`), so the check at keypress time is a plain set
 * lookup. Accepts whatever a user is likely to type: a bare letter means Ctrl
 * plus that letter, and `ctrl+c`, `Ctrl-C` and vim's own `<C-c>` all name the
 * same chord. Tokens are split on spaces and commas; anything that isn't a
 * single key with Ctrl (and optionally Shift) is dropped rather than guessed at.
 */
export function parseChordList(raw: unknown): Set<string> {
  const keys = new Set<string>();
  if (typeof raw !== "string") return keys;
  for (let token of raw.split(/[\s,]+/)) {
    token = token.trim().toLowerCase();
    if (!token) continue;
    const vimForm = /^<(.+)>$/.exec(token);
    if (vimForm) token = vimForm[1];
    // Split on + or -, but keep a trailing one as the key itself (`ctrl+-`).
    const parts = token.split(/[+-](?=.)/);
    const key = parts.pop()!;
    if (key.length !== 1) continue;
    let shift = false;
    let valid = true;
    for (const mod of parts) {
      if (mod === "ctrl" || mod === "c") continue;
      if (mod === "shift" || mod === "s") shift = true;
      else valid = false;
    }
    if (!valid) continue;
    keys.add(`${shift ? "Shift-" : ""}Ctrl-${key}`);
  }
  return keys;
}

/** The inverse of parseChordList, in its shortest spelling: `c`, `shift+z`. */
export function formatChordList(keys: Iterable<string>): string {
  return [...keys].map((k) => k.replace(/^Shift-Ctrl-/, "shift+").replace(/^Ctrl-/, "")).join(" ");
}

const EDITOR_KEYS = "textEditor.vimEditorKeys";
const VIM_KEYS = "textEditor.vimKeys";

// Parsed lists, re-parsed only when the stored string changes: the lookup runs
// on every keypress.
const parsedCache = new Map<string, { raw: unknown; keys: Set<string> }>();

function chordList(settingKey: string): Set<string> {
  const raw = api?.get(settingKey);
  const cached = parsedCache.get(settingKey);
  if (cached && cached.raw === raw) return cached.keys;
  const keys = parseChordList(raw);
  parsedCache.set(settingKey, { raw, keys });
  return keys;
}

export type ChordOwner = "editor" | "vim";

/**
 * Who a Ctrl chord belongs to while vim is on, or null when the user hasn't
 * said. A chord in both lists goes to the editor: the editor list is the one
 * that asks for a change from vim's default, so it is the one that was meant.
 */
export function chordOwner(chord: string): ChordOwner | null {
  if (chordList(EDITOR_KEYS).has(chord)) return "editor";
  if (chordList(VIM_KEYS).has(chord)) return "vim";
  return null;
}

/** Records the answer to "vim or editor?" by moving `chord` into one list and
 * out of the other. */
export function setChordOwner(chord: string, owner: ChordOwner): void {
  if (!api?.set) return;
  const [into, outOf] = owner === "editor" ? [EDITOR_KEYS, VIM_KEYS] : [VIM_KEYS, EDITOR_KEYS];
  const add = new Set(chordList(into));
  add.add(chord);
  const remove = new Set(chordList(outOf));
  // Only rewrite the other list when it actually held the chord, so a
  // hand-written list isn't reformatted for nothing.
  if (remove.delete(chord)) api.set(outOf, formatChordList(remove));
  api.set(into, formatChordList(add));
}

export function lineNumbersMode(): LineNumbersMode {
  const raw = api?.get("textEditor.lineNumbers");
  return raw === "on" || raw === "relative" || raw === "off" ? raw : "auto";
}

/**
 * The `lineNumbers` value to hand Monaco. "auto" follows vim: relative numbers
 * are what make vim's counted motions (`5j`, `d3k`) readable, and they are
 * noise without the modal keys to use them, so the default tracks the vim
 * setting rather than forcing a second toggle.
 *
 * Monaco's "relative" is really vim's `number relativenumber` hybrid — the
 * cursor's own line shows its absolute number, every other line its distance.
 */
export function lineNumbersOption(): "on" | "relative" | "off" {
  const mode = lineNumbersMode();
  if (mode === "auto") return vimEnabled() ? "relative" : "on";
  return mode;
}

export function minimapMode(): MinimapMode {
  const raw = api?.get("textEditor.minimap");
  return raw === "on" || raw === "off" ? raw : "auto";
}

/**
 * Whether a file editor should draw the minimap right now. "auto" keeps the
 * original rule: useful on a desktop pane, dead weight on a phone-width one.
 */
export function minimapEnabled(): boolean {
  const mode = minimapMode();
  if (mode === "on") return true;
  if (mode === "off") return false;
  return !matchMedia("(pointer: coarse) and (hover: none)").matches;
}
