// Touch, mouse and keys-strip options, kept per device in localStorage:
// what each touch gesture does, trackpad speed and acceleration, scrolling,
// the mouse's Back button, and which keys the phone-keyboard strip holds.
// The same options, defaults and acceleration curve as QuickRemote's
// Android app and web page, so a desktop feels the same from each.

export type Action = "none" | "left" | "right" | "middle" | "double" | "keyboard" | "drag";

export interface GestureSettings {
  doubleTap: Action;
  longPress: Action;
  twoTap: Action;
  threeTap: Action;
  fourTap: Action;
  /** Trackpad mode: tap, then touch again and move ("drag" or "none"). */
  tapDrag: Action;
  /** Scales trackpad motion and two-finger scrolling (0.5–2). */
  sensitivity: number;
  acceleration: boolean;
  /** The trackpad's overall speed (0.5–2). */
  speed: number;
  invertScroll: boolean;
  /** What a mouse's Back button sends. */
  back: "back" | "right" | "middle";
  /** The strip's keys, by id, in order. */
  keys: string[];
  keyRows: number;
}

export interface StripKey {
  id: string;
  code: number;
  label: string;
  title?: string;
  modifier: boolean;
}

export const STRIP_KEYS: StripKey[] = [];
{
  const k = (id: string, label: string, code: number, modifier = false, title?: string) => STRIP_KEYS.push({ id, label, code, modifier, title });
  k("esc", "Esc", 1);
  k("tab", "Tab", 15);
  k("ctrl", "Ctrl", 29, true);
  k("alt", "Alt", 56, true);
  k("shift", "Shift", 42, true);
  k("super", "Super", 125, true);
  k("left", "←", 105, false, "Left");
  k("up", "↑", 103, false, "Up");
  k("down", "↓", 108, false, "Down");
  k("right", "→", 106, false, "Right");
  k("home", "Home", 102);
  k("end", "End", 107);
  k("pgup", "PgUp", 104);
  k("pgdn", "PgDn", 109);
  k("ins", "Ins", 110, false, "Insert");
  k("del", "Del", 111, false, "Delete");
  for (let i = 1; i <= 10; i++) k(`f${i}`, `F${i}`, 58 + i);
  k("f11", "F11", 87);
  k("f12", "F12", 88);
}
export const DEFAULT_KEYS = ["esc", "tab", "ctrl", "alt", "super", "left", "up", "down", "right", "home", "end", "pgup", "pgdn"];
export const MODIFIER_CODES = new Set(STRIP_KEYS.filter((k) => k.modifier).map((k) => k.code));

export const TAP_ACTIONS: Action[] = ["none", "left", "right", "middle", "double", "keyboard"];
export const ACTION_LABEL: Record<Action, string> = {
  none: "Nothing",
  left: "Left click",
  right: "Right click",
  middle: "Middle click",
  double: "Double click",
  keyboard: "Keyboard",
  drag: "Drag",
};

export const GESTURE_DEFAULTS: GestureSettings = {
  doubleTap: "none",
  longPress: "right",
  twoTap: "right",
  threeTap: "middle",
  fourTap: "keyboard",
  tapDrag: "drag",
  sensitivity: 1,
  acceleration: true,
  speed: 1,
  invertScroll: false,
  back: "back",
  keys: DEFAULT_KEYS,
  keyRows: 1,
};

const KEY = "remoteDesktop.input.device";

/** Fills in defaults and drops what an older or newer version stored that this one doesn't know. */
export function normalizeGestures(raw: Partial<GestureSettings> | null | undefined): GestureSettings {
  const s = { ...GESTURE_DEFAULTS, ...(raw ?? {}) };
  const act = (a: unknown, d: Action, ok: Action[]) => (ok.includes(a as Action) ? (a as Action) : d);
  const all: Action[] = [...TAP_ACTIONS, "drag"];
  const num = (v: unknown, d: number) => (typeof v === "number" && v >= 0.5 && v <= 2 ? v : d);
  const keys = Array.isArray(s.keys) ? s.keys.filter((id) => STRIP_KEYS.some((k) => k.id === id)) : [];
  return {
    doubleTap: act(s.doubleTap, "none", TAP_ACTIONS),
    longPress: act(s.longPress, "right", all),
    twoTap: act(s.twoTap, "right", TAP_ACTIONS),
    threeTap: act(s.threeTap, "middle", TAP_ACTIONS),
    fourTap: act(s.fourTap, "keyboard", TAP_ACTIONS),
    tapDrag: act(s.tapDrag, "drag", ["drag", "none"]),
    sensitivity: num(s.sensitivity, 1),
    acceleration: s.acceleration !== false,
    speed: num(s.speed, 1),
    invertScroll: s.invertScroll === true,
    back: s.back === "right" || s.back === "middle" ? s.back : "back",
    keys: keys.length ? keys : DEFAULT_KEYS,
    keyRows: s.keyRows === 2 || s.keyRows === 3 ? s.keyRows : 1,
  };
}

export function loadGestures(): GestureSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalizeGestures(JSON.parse(raw) as Partial<GestureSettings>);
  } catch {
    // Private window or blocked storage: defaults.
  }
  return { ...GESTURE_DEFAULTS };
}

export function saveGestures(s: GestureSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not kept; fine for this visit.
  }
}

export function stripKeys(s: GestureSettings): StripKey[] {
  return s.keys.map((id) => STRIP_KEYS.find((k) => k.id === id)).filter((k): k is StripKey => !!k);
}

/**
 * Trackpad acceleration, the same curve on every QuickRemote viewer: finger
 * speed `v` in CSS px per ms → a gain on the finger's travel.
 */
export function gain(v: number, accel: boolean, speed: number): number {
  return speed * (accel ? Math.min(3, Math.max(0.5, 0.5 + 1.6 * v)) : 1);
}

/** The protocol button an action clicks (0 for none, the keyboard and drag). */
export function actionButton(a: Action): number {
  return a === "left" || a === "double" ? 1 : a === "right" ? 3 : a === "middle" ? 2 : 0;
}

/** The protocol button a mouse's Back button sends. */
export function backButton(s: GestureSettings): number {
  return s.back === "right" ? 3 : s.back === "middle" ? 2 : 4;
}
