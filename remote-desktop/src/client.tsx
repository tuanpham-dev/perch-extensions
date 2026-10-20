// Remote Desktop: a Linux desktop streamed into a tab through QuickRemote's
// qr-host (see server.js for how the session is started and why the stream
// port has to live in a terminal session). The sidebar panel owns
// download/start/stop/launch; the viewer tab (never file-matched) connects
// to whatever port is live and does everything else client-side.
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
    component: React.ComponentType<{ actionsTarget?: HTMLDivElement | null }>;
  }): void;
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    mode?: "default" | "preview";
    // A host without global viewers ignores it.
    global?: boolean;
    // The tab bar's icon for this viewer's tabs. Older hosts ignore it.
    icon?: string;
    component: React.ComponentType<ViewerProps>;
  }): void;
  app: {
    getActiveContext(): { sessionName: string | null; windowIndex: number | null; cwd: string | null };
    openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
  };
  settings?: {
    get(key: string): unknown;
    onDidChange(cb: () => void): () => void;
    // Opens Settings at this extension's section. Older hosts lack it.
    open?(): void;
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
    openSettings: ctx.settings?.open ? () => ctx.settings?.open?.() : undefined,
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
    // One desktop for the whole machine, not one project's: the tab stays
    // in the tab bar across projects instead of joining the chip of the
    // project that was active when it opened.
    global: true,
    // Same icon as the sidebar tab: the path names no file, so the tab
    // would otherwise get the generic file icon.
    icon: "vm",
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
