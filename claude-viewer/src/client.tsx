// claude-viewer: a Claude Code terminal session as a chat tab. Registers the
// tab viewer and an icon on every window running Claude (in the PROJECTS
// pane and the tab bar) that opens it; the icon turns into a bell while that
// window waits on a prompt.
import "./style.css";
import { getJson, host } from "./bridge";
import { ChatTab } from "./ChatTab";
import { stopThemeTracking } from "./Highlight";
import { injectStylesheet } from "./injectStylesheet";

type WindowCtx = { sessionName: string; windowIndex: number; cwd: string; command: string };
type WindowRow = { windowId: string; sessionName: string; windowIndex: number; waiting: boolean };

let removeStylesheet: (() => void) | null = null;
let pollTimer: number | null = null;
let programs = new Set<string>(["claude"]);
const waiting = new Set<string>();

const rowKey = (sessionName: string, windowIndex: number) => `${sessionName}:${windowIndex}`;

let refreshRows: (() => void) | null = null;

async function refreshWindows() {
  try {
    const { windows } = await getJson<{ windows: WindowRow[] }>("/windows");
    const next = new Set(windows.filter((w) => w.waiting).map((w) => rowKey(w.sessionName, w.windowIndex)));
    const changed = next.size !== waiting.size || [...next].some((k) => !waiting.has(k));
    waiting.clear();
    for (const k of next) waiting.add(k);
    if (changed) refreshRows?.();
  } catch {
    // Kept as it was.
  }
}

export function activate(ctx: {
  registerWindowAction(action: {
    id: string;
    icon: string | ((w: WindowCtx) => string);
    title: string;
    isVisible: (w: WindowCtx) => boolean;
    onClick: (w: WindowCtx) => void;
    showInTabBar?: boolean;
  }): { refresh(): void } | void;
  registerFileViewer(viewer: { id: string; extensions: string[]; mode?: "default" | "preview"; editorFallback?: boolean; component: typeof ChatTab }): void;
  registerCommand?(command: { id: string; title: string; run: () => void }): void;
  app: {
    openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
    getActiveContext?(): { sessionName: string | null; windowIndex: number | null };
  } & import("./bridge").AppApi;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  settings: { get(key: string): unknown; onDidChange(cb: () => void): () => void };
}) {
  host.serverFetch = ctx.serverFetch;
  host.assetUrl = ctx.assetUrl;
  host.settings = ctx.settings;
  host.app = ctx.app;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  getJson<{ programs: string[] }>("/capabilities")
    .then((c) => {
      if (Array.isArray(c.programs) && c.programs.length > 0) programs = new Set(c.programs);
    })
    .catch(() => {});
  void refreshWindows();
  pollTimer = window.setInterval(refreshWindows, 3000);

  const open = async (sessionName: string, windowIndex: number) => {
    const { windowId } = await getJson<{ windowId: string }>(
      `/window-id?session=${encodeURIComponent(sessionName)}&index=${windowIndex}`,
    );
    ctx.app.openViewerTab("chat", `claude-viewer/${windowId}`, { title: `${sessionName} · Claude` });
  };

  ctx.registerFileViewer({ id: "chat", extensions: [], mode: "default", editorFallback: false, component: ChatTab });

  const handle = ctx.registerWindowAction({
    id: "open",
    icon: (w) => (waiting.has(rowKey(w.sessionName, w.windowIndex)) ? "bell-dot" : "claude"),
    title: "Open in Claude Viewer",
    isVisible: (w) => programs.has(w.command),
    showInTabBar: true,
    onClick: (w) => void open(w.sessionName, w.windowIndex).catch(() => {}),
  });
  refreshRows = handle ? handle.refresh : null;
}

export function deactivate() {
  removeStylesheet?.();
  removeStylesheet = null;
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = null;
  refreshRows = null;
  stopThemeTracking();
}
