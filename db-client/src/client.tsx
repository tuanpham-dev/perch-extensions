// DB Client: a DATABASES section of saved connections and their schemas, and
// query tabs - SQL with a results grid, a MongoDB query bar, a Redis key
// browser and console. Everything runs on the server hook (../server/), which
// enforces read-only connections and keeps passwords in Perch's secret store.
import { DatabasesPanel } from "./DatabasesPanel";
import { call, getConnections, host, openQueryTab, refreshConnections, type AppApi, type Connection } from "./host";
import { injectStylesheet } from "./injectStylesheet";
import { QueryTab } from "./QueryTab";
import "./style.css";

interface ExtensionContext {
  app: AppApi;
  // The host's extension storage (Perch 0.9+), where the server keeps
  // connections and history; without it the extension doesn't run.
  storage?: unknown;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  registerCommand(cmd: { id: string; label: string; run: () => void }): void;
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location?: "tab" | "explorer" | "run" | "commands";
    order?: number;
    component: typeof DatabasesPanel;
  }): void;
  registerFileViewer(viewer: { id: string; extensions: string[]; global?: boolean; icon?: string; component: typeof QueryTab }): void;
  registerFileMenuItem(item: {
    id: string;
    label: string;
    icon?: string;
    order?: number;
    isVisible: (path: string, isDir: boolean) => boolean;
    onClick: (path: string) => void;
  }): void;
}

let removeStylesheet: (() => void) | null = null;

const SQLITE_FILE = /\.(sqlite3?|db)$/i;

async function openSqliteFile(file: string) {
  const existing = (getConnections() ?? (await refreshConnections())).find((c) => c.engine === "sqlite" && c.file === file);
  const conn = existing ?? (await call<Connection>("/connections", { method: "POST", body: JSON.stringify({ engine: "sqlite", file, name: file.split(/[\\/]/).pop() }) }));
  if (!existing) await refreshConnections();
  openQueryTab(conn, { text: "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%';", run: true }, "tables");
  host.app?.revealSidebarPanel?.("databases");
}

function NeedsNewerPerch() {
  return <div className="db-muted db-pad">DB Client needs Perch 0.9 or newer. Update Perch to use it.</div>;
}

export function activate(ctx: ExtensionContext): void {
  if (!ctx.storage) {
    ctx.registerSidebarPanel({ id: "databases", title: "DATABASES", icon: "database", location: "explorer", order: 40, component: NeedsNewerPerch as typeof DatabasesPanel });
    return;
  }
  host.app = ctx.app;
  host.serverFetch = ctx.serverFetch;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerSidebarPanel({ id: "databases", title: "DATABASES", icon: "database", location: "explorer", order: 40, component: DatabasesPanel });
  ctx.registerFileViewer({ id: "query", extensions: [], global: true, icon: "database", component: QueryTab });

  ctx.registerFileMenuItem({
    id: "open",
    label: "Open in Database Client",
    icon: "database",
    order: 60,
    isVisible: (path, isDir) => !isDir && SQLITE_FILE.test(path),
    onClick: (path) => void openSqliteFile(path).catch(() => {}),
  });

  ctx.registerCommand({
    id: "show",
    label: "DB Client: Show Databases",
    run: () => ctx.app.revealSidebarPanel?.("databases"),
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  host.app = null;
  host.serverFetch = null;
}
