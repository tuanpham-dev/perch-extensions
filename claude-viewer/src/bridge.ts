// Host handles set once in activate(), read by the components (the pattern
// every bundled-style extension uses).

export type SettingsApi = {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
};

export type TokenColorRule = {
  scope?: string | string[];
  settings?: { foreground?: string; background?: string; fontStyle?: string };
};

export type AppApi = {
  openSessionWindow?(sessionName: string, opts?: { createCwd?: string; windowIndex?: number }): void;
  getThemeColors?(): Record<string, string>;
  getTokenColors?(): TokenColorRule[];
  onDidChangeColorTheme?(cb: () => void): () => void;
};

export const host: {
  serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null;
  assetUrl: ((relPath: string) => string) | null;
  settings: SettingsApi | null;
  app: AppApi | null;
} = { serverFetch: null, assetUrl: null, settings: null, app: null };

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (!host.serverFetch) throw new Error("not active");
  const res = await host.serverFetch(path, { signal });
  if (!res.ok) throw Object.assign(new Error(`${res.status}`), { status: res.status });
  return (await res.json()) as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  if (!host.serverFetch) throw new Error("not active");
  const res = await host.serverFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null as T;
  try {
    data = (await res.json()) as T;
  } catch {
    // Empty body.
  }
  return { status: res.status, data };
}

export function setting<T>(key: string, fallback: T): T {
  const v = host.settings?.get(key);
  return v === undefined || v === null ? fallback : (v as T);
}

const UPLOAD_DIR = "{tmp}/perch-claude-viewer";

// A file into the server's temp folder through core's upload route, returning
// its absolute path: how an attached or dropped file reaches Claude Code,
// which takes files as paths typed into its input.
export async function uploadFile(file: File): Promise<string> {
  const safe = (file.name || "file").replace(/[^\w.-]+/g, "_").slice(-80) || "file";
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safe}`;
  const res = await fetch(`/api/upload?dir=${encodeURIComponent(UPLOAD_DIR)}&path=${encodeURIComponent(name)}&conflict=rename`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  return ((await res.json()) as { path: string }).path;
}
