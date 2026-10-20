// HTTP Client: .http request files opened as a tab with a Send button per
// request, a scratch request tab, and Open in HTTP Client on a listening
// port. Requests go out from the server hook (../server.js).
import { host, pendingScratch, type AppApi } from "./host";
import { HttpTab, SCRATCH_PREFIX } from "./HttpTab";
import { injectStylesheet } from "./injectStylesheet";
import "./style.css";

interface ExtensionContext {
  app: AppApi;
  // The host's extension storage (Perch 0.9+), where the server keeps request
  // history; without it the extension doesn't run.
  storage?: unknown;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  registerCommand(cmd: { id: string; label: string; run: () => void }): void;
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    mode?: "default" | "preview";
    global?: boolean;
    icon?: string;
    component: typeof HttpTab;
  }): void;
  registerPortMenuItem?(item: {
    id: string;
    label: string;
    icon?: string;
    onClick: (port: { port: number; address: string }) => void;
  }): void;
}

let removeStylesheet: (() => void) | null = null;
let scratchCount = 0;

function openScratch(url = "") {
  scratchCount += 1;
  const tabPath = `${SCRATCH_PREFIX}${scratchCount}`;
  if (url) pendingScratch.set(tabPath, url);
  host.app?.openViewerTab("scratch", tabPath, { title: url ? `HTTP · ${url.replace(/^https?:\/\//, "")}` : "New Request" });
}

function NeedsNewerPerch() {
  return <div className="hc-muted">HTTP Client needs Perch 0.9 or newer. Update Perch to use it.</div>;
}

export function activate(ctx: ExtensionContext): void {
  if (!ctx.storage) {
    ctx.registerFileViewer({ id: "http", extensions: ["http", "rest"], mode: "preview", icon: "globe", component: NeedsNewerPerch as typeof HttpTab });
    return;
  }
  host.app = ctx.app;
  host.serverFetch = ctx.serverFetch;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  // Preview mode: Preview opens the request runner; a plain click still
  // opens the file in your editor.
  ctx.registerFileViewer({ id: "http", extensions: ["http", "rest"], mode: "preview", icon: "globe", component: HttpTab });
  ctx.registerFileViewer({ id: "scratch", extensions: [], global: true, icon: "globe", component: HttpTab });

  ctx.registerCommand({ id: "newRequest", label: "HTTP: New Request", run: () => openScratch() });

  ctx.registerPortMenuItem?.({
    id: "open",
    label: "Open in HTTP Client",
    icon: "globe",
    onClick: ({ port }) => openScratch(`http://localhost:${port}/`),
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  host.app = null;
  host.serverFetch = null;
  pendingScratch.clear();
}
