// The slice of the host API this extension uses, set once from activate().
export interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

export interface AppApi {
  getActiveContext(): ActiveContext;
  onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
  openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
  openSessionWindow?(sessionName: string, opts?: { windowIndex?: number }): void;
}

export const host: {
  app: AppApi | null;
  serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null;
} = { app: null, serverFetch: null };

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!host.serverFetch) throw new Error("Agent Sessions isn't active");
  const res = await host.serverFetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface ListedSession {
  id: string;
  cwd: string;
  title: string;
  lastActiveAt: number;
  messageCount: number;
  agentId: string;
  agentLabel: string;
  iconUrl: string;
  icon: string;
  canResume: boolean;
  openIn: { sessionName: string; windowIndex: number; windowId: string } | null;
  branch: string | null;
  // In the all-projects list: the project folder it belongs to.
  project?: string;
}

export interface SessionMessage {
  role: "user" | "assistant" | "tool";
  text: string;
}

// The viewer's tab path for a project folder, and back.
export const TAB_PREFIX = "agent-sessions://";
export const tabPathFor = (cwd: string) => `${TAB_PREFIX}${cwd}`;
export const cwdOfTab = (tabPath: string) => (tabPath.startsWith(TAB_PREFIX) ? tabPath.slice(TAB_PREFIX.length) : tabPath);

export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed;
}

export function relativeTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// A selection the tab should land on when it opens (from Ctrl+P).
let pendingSelection: string | null = null;
export const selectionKey = (s: Pick<ListedSession, "agentId" | "id">) => `${s.agentId}\u0000${s.id}`;
export function setPendingSelection(key: string | null) {
  pendingSelection = key;
}
export function takePendingSelection(): string | null {
  const key = pendingSelection;
  pendingSelection = null;
  return key;
}
