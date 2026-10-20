// Agent Sessions: a project's past agent conversations in one tab - search,
// filter by agent, preview, and Resume in a new terminal. The conversations
// come from core's session readers (see ../server.js); this side renders.
import { basename, call, host, selectionKey, setPendingSelection, tabPathFor, type AppApi, type ListedSession } from "./host";
import { injectStylesheet } from "./injectStylesheet";
import { SessionsTab } from "./SessionsTab";
import "./style.css";

interface ExtensionContext {
  app: AppApi;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  registerCommand(cmd: { id: string; label: string; run: () => void }): void;
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    global?: boolean;
    icon?: string;
    component: typeof SessionsTab;
  }): void;
  registerTabGroupMenuItem(item: {
    id: string;
    label: string;
    icon?: string;
    order?: number;
    isVisible: (ctx: { sessionName: string; cwd: string | null }) => boolean;
    onClick: (ctx: { sessionName: string; cwd: string | null }) => void;
  }): void;
  registerQuickSwitcherProvider(provider: {
    id: string;
    provideResults(query: string): { label: string; tag?: string; run(secondary: boolean): void }[];
  }): { refresh(): void };
}

let removeStylesheet: (() => void) | null = null;
const cleanups: Array<() => void> = [];
// The active project's conversations, for Ctrl+P (which asks synchronously,
// per keystroke).
let cached: { cwd: string; sessions: ListedSession[] } | null = null;

function openTab(cwd: string) {
  host.app?.openViewerTab("sessions", tabPathFor(cwd), { title: `Agent Sessions · ${basename(cwd)}` });
}

async function projectFolder(sessionName: string | null): Promise<string | null> {
  if (!sessionName) return null;
  try {
    const res = await fetch("/api/sessions");
    const list = (await res.json()) as { name: string; path: string }[];
    return list.find((s) => s.name === sessionName)?.path ?? null;
  } catch {
    return null;
  }
}

async function refreshCache() {
  const folder = await projectFolder(host.app?.getActiveContext().sessionName ?? null);
  if (!folder) {
    cached = null;
    return;
  }
  try {
    const { sessions } = await call<{ sessions: ListedSession[] }>(`/sessions?cwd=${encodeURIComponent(folder)}`);
    cached = { cwd: folder, sessions };
  } catch {
    // Ctrl+P just shows no conversations until the next try
  }
}

export function activate(ctx: ExtensionContext): void {
  host.app = ctx.app;
  host.serverFetch = ctx.serverFetch;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerFileViewer({ id: "sessions", extensions: [], global: true, icon: "history", component: SessionsTab });

  ctx.registerTabGroupMenuItem({
    id: "browse",
    label: "Browse Agent Sessions…",
    icon: "history",
    order: 40,
    isVisible: () => true,
    onClick: async ({ sessionName, cwd }) => {
      const folder = (await projectFolder(sessionName)) ?? cwd;
      if (folder) openTab(folder);
    },
  });

  ctx.registerCommand({
    id: "browse",
    label: "Agent Sessions: Browse Agent Sessions…",
    run: async () => {
      const active = ctx.app.getActiveContext();
      const folder = (await projectFolder(active.sessionName)) ?? active.cwd;
      if (folder) openTab(folder);
    },
  });

  const switcher = ctx.registerQuickSwitcherProvider({
    id: "sessions",
    provideResults(query) {
      const q = query.trim().toLowerCase();
      if (!cached || q.length < 2) return [];
      const { cwd, sessions } = cached;
      return sessions
        .filter((s) => s.title.toLowerCase().includes(q))
        .slice(0, 8)
        .map((s) => ({
          label: s.title,
          tag: "session",
          run: () => {
            setPendingSelection(selectionKey(s));
            openTab(cwd);
          },
        }));
    },
  });

  const update = () => void refreshCache().then(() => switcher.refresh());
  update();
  cleanups.push(ctx.app.onDidChangeContext(update));
  const timer = setInterval(() => !document.hidden && update(), 60_000);
  cleanups.push(() => clearInterval(timer));
}

export function deactivate(): void {
  for (const fn of cleanups.splice(0)) fn();
  removeStylesheet?.();
  removeStylesheet = null;
  host.app = null;
  host.serverFetch = null;
  cached = null;
}
