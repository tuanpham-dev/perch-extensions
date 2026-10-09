// What activate() receives from the host, kept for the components, and the
// calls to this extension's own server side (server.js).

export interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

export interface DownloadStatus {
  state: "idle" | "running" | "done" | "error";
  /** 0 to 100 while running; the whole download when done. */
  percent: number;
  error: string | null;
  /** The release version being (or just) fetched. */
  version: string | null;
}

export interface RdStatus {
  /** A usable qr-host was found: at least the required version. */
  installed: boolean;
  serverPath: string;
  serverReason: "missing" | "outdated" | null;
  /** The found binary's version, usable or not. */
  engineVersion: string | null;
  requiredVersion: string;
  /** Where the binary came from. */
  engineSource: "setting" | "downloaded" | "path" | "cargo" | null;
  /** A remoteDesktop.serverPath that is not qr-host (a leftover
   * quicdesk-server path), skipped in favour of the other candidates. */
  settingIgnored: string | null;
  mode: "managed" | "existing";
  display: string;
  desktopCommand: string;
  renderer: "auto" | "gpu" | "software";
  running: boolean;
  port: number | null;
  viewers: number;
  width: number;
  height: number;
  scale: number;
  codec: string | null;
  encoder: string | null;
  /** How the managed display renders: on the GPU, or in software when the
   * host cannot open the render node (the hint in the panel says why). */
  hostRenderer: "gpu" | "software" | null;
  source: string | null;
  cursorInPicture: boolean;
  /** Host packages managed mode needs that are not installed. */
  missing: string[];
  /** The managed display's environment, for Launch. */
  displayEnv: { DISPLAY?: string; WAYLAND_DISPLAY?: string } | null;
  download: DownloadStatus;
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

export function getHostOrNull(): HostBindings | null {
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

export async function fetchDownloadStatus(): Promise<DownloadStatus> {
  const res = await fetchWithTimeout("/download/status");
  const body = (await res.json().catch(() => null)) as DownloadStatus | { error?: string } | null;
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return body as DownloadStatus;
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

// The per-device choices moved to settings.ts; re-exported so existing
// imports keep working.
export {
  AUTO_RATIO_CAP,
  detectedPixelRatio,
  deviceRatioChoice,
  effectivePixelRatio,
  fsControlsPos,
  setDeviceRatioChoice,
  setFsControlsPos,
  syncedRatioChoice,
  type ControlsPos,
  type RatioChoice,
} from "./settings";
