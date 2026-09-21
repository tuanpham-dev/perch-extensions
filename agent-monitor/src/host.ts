// The host pieces the AGENTS board reaches for, set once in client.tsx's
// activate() and cleared in deactivate(). A module of its own rather than
// exports of client.tsx so the view never imports the entry that imports it.

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  icon?: string;
}

export interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

export interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

export interface AppApi {
  openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
  openSessionWindow(sessionName: string, opts?: { createCwd?: string; windowIndex?: number }): void;
  killSession(sessionName: string): void;
  confirmDialog(message: string, confirmLabel?: string): Promise<boolean>;
  getActiveContext(): ActiveContext;
  onDidChangeContext(cb: (next: ActiveContext) => void): () => void;
}

export const host: {
  serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null;
  app: AppApi | null;
  settings: SettingsApi | null;
} = { serverFetch: null, app: null, settings: null };

export async function getJson<T>(path: string): Promise<T> {
  if (!host.serverFetch) throw new Error("agent-monitor is not active");
  const res = await host.serverFetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `${res.status} ${res.statusText}`);
  return body as T;
}

// Settings keys this extension declares (package.json).
export const SETTING_DEFAULT_SCOPE = "agentMonitor.board.defaultScope";
export const SETTING_POLL_INTERVAL = "agentMonitor.board.pollInterval";

export function pollIntervalMs(): number {
  const raw = Number(host.settings?.get(SETTING_POLL_INTERVAL));
  return Number.isFinite(raw) && raw >= 1000 ? Math.min(raw, 60_000) : 5000;
}

// The Clipboard API needs a secure context, which a LAN address is not; the
// hidden-textarea copy still works there. Both failing is silent, like the
// app's own copy paths.
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
  } catch {
    // Nothing left to try.
  }
  area.remove();
}
