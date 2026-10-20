// The slice of the host API this extension uses, set once from activate().
export interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

export interface PickItem {
  id: string;
  label: string;
  icon?: string;
  detail?: string;
  keywords?: string[];
}

export interface AppApi {
  getActiveContext(): ActiveContext;
  onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
  onDidRenameFiles?(cb: (pairs: { from: string; to: string }[]) => void): () => void;
  revealSidebarPanel?(panelId: string): void;
  openSessionWindow?(sessionName: string, opts?: { windowIndex?: number }): void;
  openFileTab?(path: string): void;
  openPreview?(path: string): void;
  pickItem?(opts: { title: string; items: PickItem[]; placeholder?: string }): Promise<string | null>;
  confirmDialog?(message: string, confirmLabel?: string): Promise<boolean>;
}

// The host's change feed for this extension's records (ctx.storage, Perch
// 0.9+). Notes only listens: its writes go through its own routes.
export type StorageNotice = { type: "change" | "resync" | "topic" };
export interface StorageApi {
  collection(name: string): { subscribe(cb: (n: StorageNotice) => void): () => void };
}

export const host: {
  app: AppApi | null;
  serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null;
} = { app: null, serverFetch: null };

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!host.serverFetch) throw new Error("Notes isn't active");
  const res = await host.serverFetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...(init.headers ?? {}) } : init?.headers,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
