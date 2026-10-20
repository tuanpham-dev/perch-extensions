// The slice of the host API this extension uses, set once from activate().
export interface AppApi {
  getActiveContext(): { sessionName: string | null; windowIndex: number | null; cwd: string | null };
  openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
  openFileTab?(path: string): void;
  promptDialog?(message: string, defaultValue?: string): Promise<string | null>;
  confirmDialog?(message: string, confirmLabel?: string): Promise<boolean>;
}

export const host: {
  app: AppApi | null;
  serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null;
} = { app: null, serverFetch: null };

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!host.serverFetch) throw new Error("HTTP Client isn't active");
  const res = await host.serverFetch(path, { ...init, headers: init?.body ? { "content-type": "application/json" } : undefined });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new HttpError((data as { error?: string } | null)?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  contentType: string;
  timeMs: number;
  sizeBytes: number;
  truncated: boolean;
  bodyBase64: string;
  url: string;
}

export interface HistoryEntry {
  at: number;
  method: string;
  url: string;
  status?: number;
  error?: string;
  timeMs?: number;
  sizeBytes?: number;
  contentType?: string;
  headers?: [string, string][];
  bodyBase64?: string;
}

// Scratch tabs' starting URLs, keyed by tab path (from Open in HTTP Client).
export const pendingScratch = new Map<string, string>();
