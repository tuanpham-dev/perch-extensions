// Remote Desktop: a Linux X11 desktop streamed into a tab through
// quicdesk-server (see server.js for how the session is started and why the
// stream port has to live in a terminal session). The sidebar panel owns
// start/stop/launch; the viewer tab (never file-matched) connects to
// whatever port is live and does everything else client-side.
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import { setHost } from "./host";
import { RemoteDesktopPanel } from "./panel";
import { RemoteDesktopView, type ViewerProps } from "./viewer";

interface ExtensionContext {
  registerCommand(command: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location: "tab" | "explorer" | "run" | "commands";
    component: React.ComponentType;
  }): void;
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    mode?: "default" | "preview";
    component: React.ComponentType<ViewerProps>;
  }): void;
  app: {
    getActiveContext(): { sessionName: string | null; windowIndex: number | null; cwd: string | null };
    openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
  };
  settings?: {
    get(key: string): unknown;
    onDidChange(cb: () => void): () => void;
  };
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
}

let removeStylesheet: (() => void) | null = null;

export function activate(ctx: ExtensionContext): void {
  setHost({
    serverFetch: ctx.serverFetch,
    openViewerTab: ctx.app.openViewerTab,
    getActiveContext: ctx.app.getActiveContext,
    assetUrl: ctx.assetUrl,
    getSetting: (key) => ctx.settings?.get(key),
    onSettingsChange: (cb) => ctx.settings?.onDidChange(cb) ?? (() => {}),
  });
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerSidebarPanel({
    id: "remoteDesktop",
    title: "Remote Desktop",
    icon: "vm",
    location: "tab",
    component: RemoteDesktopPanel,
  });

  ctx.registerFileViewer({
    id: "remoteDesktopView",
    extensions: [],
    mode: "default",
    component: RemoteDesktopView,
  });

  ctx.registerCommand({
    id: "openDisplay",
    label: "Remote Desktop: Open Display",
    run: () => ctx.app.openViewerTab("remoteDesktopView", "remote-desktop://display", { title: "Remote Desktop" }),
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  setHost(null);
}
