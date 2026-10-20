// The slice of the host API this extension uses, set once from activate(),
// and the server routes' shapes.
export interface AppApi {
  getActiveContext(): { sessionName: string | null; windowIndex: number | null; cwd: string | null };
  onDidChangeContext(cb: (ctx: { sessionName: string | null; cwd: string | null }) => void): () => void;
  openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
  confirmDialog?(message: string, confirmLabel?: string): Promise<boolean>;
  promptDialog?(message: string, defaultValue?: string): Promise<string | null>;
  revealSidebarPanel?(panelId: string): void;
}

export const host: {
  app: AppApi | null;
  serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null;
} = { app: null, serverFetch: null };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!host.serverFetch) throw new Error("DB Client isn't active");
  const res = await host.serverFetch(path, { ...init, headers: init?.body ? { "content-type": "application/json" } : undefined });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((data as { error?: string } | null)?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export type Engine = "sqlite" | "postgres" | "mysql" | "redis" | "mongo";

export const ENGINE_LABELS: Record<Engine, string> = {
  sqlite: "SQLite",
  postgres: "PostgreSQL",
  mysql: "MySQL / MariaDB",
  redis: "Redis",
  mongo: "MongoDB",
};

export const ENGINE_SHORT: Record<Engine, string> = {
  sqlite: "sqlite",
  postgres: "postgres",
  mysql: "mysql",
  redis: "redis",
  mongo: "mongo",
};

export interface Connection {
  id: string;
  name: string;
  engine: Engine;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  file?: string;
  url?: string;
  ssl?: boolean;
  writable: boolean;
  hasPassword: boolean;
}

export interface SchemaTable {
  name: string;
  kind: string;
  count?: number;
  columns: { name: string; type: string }[];
}

export interface Schema {
  database: string | null;
  groups: { name: string; kind: string; children: SchemaTable[] }[];
}

export interface RowsResult {
  kind: "rows";
  columns: { name: string; type: string }[];
  rows: unknown[][];
  truncated: boolean;
  rowCount: number;
  notes: string[];
  timeMs: number;
  limit: number;
}

// ---- Shared connection list ----

let connections: Connection[] | null = null;
const listeners = new Set<() => void>();

export async function refreshConnections(): Promise<Connection[]> {
  const { connections: list } = await call<{ connections: Connection[] }>("/connections");
  connections = list;
  for (const l of listeners) l();
  return list;
}

export function getConnections(): Connection[] | null {
  return connections;
}

export function subscribeConnections(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ---- Query tabs ----

export const TAB_PREFIX = "db-client://";
let tabSeq = 0;

// What a query tab should start with: its text (and run it), a Mongo
// collection, or a Redis key pattern.
export interface TabStart {
  text?: string;
  run?: boolean;
  db?: string;
  collection?: string;
  pattern?: string;
}
export const pendingTabs = new Map<string, TabStart>();

export function openQueryTab(conn: Connection, start: TabStart = {}, label?: string) {
  tabSeq += 1;
  const tabPath = `${TAB_PREFIX}${conn.id}/${tabSeq}`;
  pendingTabs.set(tabPath, start);
  host.app?.openViewerTab("query", tabPath, { title: `${conn.name} · ${label ?? `query ${tabSeq}`}` });
}

export function connectionIdOfTab(tabPath: string): string {
  return tabPath.slice(TAB_PREFIX.length).split("/")[0];
}

const q = (engine: Engine, s: string) => (engine === "mysql" ? `\`${s.replace(/`/g, "``")}\`` : `"${s.replace(/"/g, '""')}"`);

export function tableQuery(engine: Engine, group: string, table: string): string {
  if (engine === "sqlite") return `SELECT * FROM ${q(engine, table)} LIMIT 100;`;
  return `SELECT * FROM ${q(engine, group)}.${q(engine, table)} LIMIT 100;`;
}

export async function toggleWritable(conn: Connection): Promise<void> {
  if (conn.writable) {
    await call(`/connections/${conn.id}`, { method: "PUT", body: JSON.stringify({ writable: false }) });
  } else {
    const ok = await host.app?.confirmDialog?.(
      `Make "${conn.name}" writable? Queries on it will be able to change and delete data.`,
      "Make Writable",
    );
    if (!ok) return;
    await call(`/connections/${conn.id}`, { method: "PUT", body: JSON.stringify({ writable: true, confirm: true }) });
  }
  await refreshConnections();
}
