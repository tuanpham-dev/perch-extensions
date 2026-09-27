// What activate() receives from the host, kept for the components.

export interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

export interface RdStatus {
  installed: boolean;
  serverPath: string;
  serverReason: "missing" | "outdated" | null;
  mode: "managed" | "existing";
  display: string;
  desktopCommand: string;
  running: boolean;
  port: number | null;
  viewers: number;
  width: number;
  height: number;
}

export interface HostBindings {
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
  getActiveContext(): ActiveContext;
  assetUrl(relPath: string): string;
  getSetting(key: string): unknown;
  onSettingsChange(cb: () => void): () => void;
}

let host: HostBindings | null = null;

export function setHost(bindings: HostBindings | null): void {
  host = bindings;
}

export function getHost(): HostBindings {
  if (!host) throw new Error("Remote Desktop extension is not active");
  return host;
}

// A status call that never answers (the host restarting mid-request) would
// otherwise leave the tab on "Loading…" forever.
const FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(path: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await getHost().serverFetch(path, { ...init, signal: ctl.signal });
  } catch (err) {
    if (ctl.signal.aborted) throw new Error("The Perch server did not answer in time.");
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function fetchStatus(): Promise<RdStatus> {
  const res = await fetchWithTimeout("/status");
  const body = (await res.json().catch(() => null)) as RdStatus | { error?: string } | null;
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return body as RdStatus;
}

export async function postJson<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const res = await fetchWithTimeout(path, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(parsed?.error ?? `${res.status} ${res.statusText}`);
  return (parsed ?? {}) as T;
}

// Perch settings sync across a person's devices, so the synced value is a
// default; this browser may override it for itself (a phone at 3x, a
// laptop that wants 1x while the 4K desktop drives at 2x).
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
  const raw = host?.getSetting("remoteDesktop.pixelRatio");
  const v = typeof raw === "number" ? String(raw) : raw;
  return v === "1" || v === "1.5" || v === "2" ? v : "auto";
}

/** What auto resolves to on this device. */
export function detectedPixelRatio(): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(AUTO_RATIO_CAP, Math.max(1, Math.round(dpr * 4) / 4));
}

// Fit to tab, per device: scale the picture to fill the tab's width or
// height (aspect ratio kept), up as well as down. Off, a follower's picture
// is only ever scaled down. Kept in this browser only.
const DEVICE_FIT_KEY = "remoteDesktop.fitToTab.device";

export function deviceFitToTab(): boolean {
  try {
    return localStorage.getItem(DEVICE_FIT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setDeviceFitToTab(on: boolean): void {
  try {
    if (on) localStorage.setItem(DEVICE_FIT_KEY, "1");
    else localStorage.removeItem(DEVICE_FIT_KEY);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

/** The ratio in force: the device override, else the synced setting. */
export function effectivePixelRatio(): number {
  const choice = deviceRatioChoice() ?? syncedRatioChoice();
  if (choice === "auto") return detectedPixelRatio();
  return Number(choice);
}
