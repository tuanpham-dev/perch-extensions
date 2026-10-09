// What this browser wants of the picture, kept in localStorage: the
// display size it asks for as driver (follow the tab or a fixed
// resolution), the view (Fit, Fill, 100%), the quality preset, whether
// audio plays, and the pixel ratio override that was in host.ts before.
// Perch settings sync across a person's devices, so the synced pixel ratio
// is a default this browser may override for itself (a phone at 3x, a
// laptop that wants 1x while the 4K desktop drives at 2x).
import { getHostOrNull } from "./host";

export type ViewMode = "fit" | "fill" | "native";
export type Quality = "high" | "medium" | "low";
export type SizeMode = "follow" | "fixed";

export interface ViewSettings {
  sizeMode: SizeMode;
  fixedW: number;
  fixedH: number;
  /** Refresh rate asked for, Hz. */
  hz: number;
  view: ViewMode;
  quality: Quality;
  audio: boolean;
  /** Pinch and Ctrl+wheel do not zoom (a phone held in one hand). */
  lockZoom: boolean;
  /** One finger on a touch screen: the pointer goes where it touches
   * (direct), or moves with it like a trackpad. */
  touchMode: TouchMode;
}
export type TouchMode = "direct" | "trackpad";

export const PRESETS: [number, number][] = [
  [1280, 720],
  [1600, 900],
  [1920, 1080],
  [2560, 1440],
  [3840, 2160],
];
export const RATES = [30, 60, 120];

const VIEW_KEY = "remoteDesktop.view.device";
const DEFAULTS: ViewSettings = { sizeMode: "follow", fixedW: 1920, fixedH: 1080, hz: 60, view: "fit", quality: "high", audio: false,
  lockZoom: false,
  touchMode: "direct" };

export function loadViewSettings(): ViewSettings {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ViewSettings>) };
  } catch {
    // Private window or blocked storage: defaults.
  }
  return { ...DEFAULTS };
}

export function saveViewSettings(s: ViewSettings): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(s));
  } catch {
    // Not kept; fine for this visit.
  }
}

/** A size from the user: even, within what the host takes. */
export function clampSize(w: number, h: number): [number, number] {
  const even = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v))) & ~1;
  return [even(w, 640, 7680), even(h, 360, 4320)];
}

// ---- Pixel ratio: a synced default and a per-device override ----

const DEVICE_RATIO_KEY = "remoteDesktop.pixelRatio.device";
/** Auto never asks for more than this: a 3x phone gets a 2x desktop. */
export const AUTO_RATIO_CAP = 2;
export type RatioChoice = "auto" | "1" | "1.5" | "2";

export function deviceRatioChoice(): RatioChoice | null {
  try {
    const v = localStorage.getItem(DEVICE_RATIO_KEY);
    return v === "auto" || v === "1" || v === "1.5" || v === "2" ? v : null;
  } catch {
    return null;
  }
}

export function setDeviceRatioChoice(choice: RatioChoice | null): void {
  try {
    if (choice === null) localStorage.removeItem(DEVICE_RATIO_KEY);
    else localStorage.setItem(DEVICE_RATIO_KEY, choice);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

export function syncedRatioChoice(): RatioChoice {
  const raw = getHostOrNull()?.getSetting("remoteDesktop.pixelRatio");
  const v = typeof raw === "number" ? String(raw) : raw;
  return v === "1" || v === "1.5" || v === "2" ? v : "auto";
}

/** What auto resolves to on this device. */
export function detectedPixelRatio(): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(AUTO_RATIO_CAP, Math.max(1, Math.round(dpr * 4) / 4));
}

/** The ratio in force: the device override, else the synced setting. */
export function effectivePixelRatio(): number {
  const choice = deviceRatioChoice() ?? syncedRatioChoice();
  if (choice === "auto") return detectedPixelRatio();
  return Number(choice);
}

// ---- Where this device keeps the floating fullscreen controls ----
// Fractions of the free space across and down (0 is the left or top edge,
// 1 the right or bottom), so the spot survives a rotation or another
// screen size.
const FS_CONTROLS_POS_KEY = "remoteDesktop.fsControlsPos";

export interface ControlsPos {
  x: number;
  y: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function fsControlsPos(): ControlsPos {
  try {
    const raw = JSON.parse(localStorage.getItem(FS_CONTROLS_POS_KEY) ?? "null") as unknown;
    if (raw && typeof raw === "object") {
      const { x, y } = raw as Record<string, unknown>;
      if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
        return { x: clamp01(x), y: clamp01(y) };
      }
    }
  } catch {
    // Storage blocked or a bad value: the default spot.
  }
  return { x: 1, y: 0 };
}

export function setFsControlsPos(pos: ControlsPos): void {
  try {
    localStorage.setItem(FS_CONTROLS_POS_KEY, JSON.stringify({ x: clamp01(pos.x), y: clamp01(pos.y) }));
  } catch {
    // Storage blocked: the spot lasts for this page only.
  }
}

/** This browser's identity towards the gateway, so a driver that reconnects
 * (a Perch restart, a network blip) can ask for its seat back. Kept per
 * tab: two tabs of one browser are two viewers. */
const VIEWER_ID_KEY = "remoteDesktop.viewerId";

export function viewerId(): string {
  try {
    const v = sessionStorage.getItem(VIEWER_ID_KEY);
    if (v) return v;
  } catch {
    // Storage blocked: a fresh id for this page.
  }
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  try {
    sessionStorage.setItem(VIEWER_ID_KEY, id);
  } catch {
    // Not kept.
  }
  return id;
}
