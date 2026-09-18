// git-history: "Git: File History" and "Git: Blame" on any tracked file,
// from the FILES tree's right-click menu. Both open read-only tabs; nothing
// here changes the repository.
//
// Host hooks arrive via module-level bridge variables set once in activate()
// — the pattern every bundled-style extension uses. Per-file diffs go
// through ctx.app.openDiff, which takes content rather than revisions, so
// this extension ships no diff viewer of its own.
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import { stopThemeTracking } from "./Highlight";
import HistoryView from "./HistoryView";
import BlameView from "./BlameView";

// ---- Module-level host bridge ----

export interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

export interface DiffRequest {
  title: string;
  original: { content: string; label: string };
  modified: { content: string; label: string; path?: string; readOnlyReason?: string };
}

export interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

export interface ThemeApi {
  getThemeColors?(): Record<string, string>;
  getTokenColors?(): unknown[];
  onDidChangeColorTheme?(cb: () => void): () => void;
}

export let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
export let openViewerTab: ((viewerId: string, path: string, opts?: { title?: string }) => void) | null = null;
export let openDiffInEditor: ((req: DiffRequest) => Promise<boolean>) | null = null;
export let openFileTab: ((path: string) => void) | null = null;
// The host's asset route, for the lazily-loaded highlighting chunk.
export let assetUrl: ((relPath: string) => string) | null = null;
// The colour theme, so highlighted code reads like the rest of the app.
export let themeApi: ThemeApi | null = null;

let removeStylesheet: (() => void) | null = null;
let removeContextListener: (() => void) | null = null;

// ---- Fetch helper ----

export async function apiGetJson<T>(path: string): Promise<T> {
  const res = await serverFetch!(path);
  const data = await res.json().catch(() => ({}) as Record<string, never>);
  if (!res.ok) throw new Error((data as { error?: string }).error || `${res.status} ${res.statusText}`);
  return data as T;
}

// ---- Tab keys ----
// A tab's identity is root + path + revision, joined with NUL (which can't
// appear in any of them) into the single string openViewerTab takes as a
// path. The visible title is set separately via its `title` option.
const KEY_SEP = "\u0000";

export function encodeKey(root: string, relPath: string, rev = ""): string {
  return [root, relPath, rev].join(KEY_SEP);
}

export function decodeKey(key: string): { root: string; relPath: string; rev: string } {
  const [root, relPath, rev] = key.split(KEY_SEP);
  return { root, relPath, rev: rev ?? "" };
}

export function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function dirnameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
];
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function formatRelativeTime(unixSeconds: number): string {
  const diff = unixSeconds - Math.floor(Date.now() / 1000);
  for (const [unit, secondsInUnit] of RELATIVE_TIME_UNITS) {
    if (Math.abs(diff) >= secondsInUnit) {
      return relativeTimeFormatter.format(Math.round(diff / secondsInUnit), unit);
    }
  }
  return relativeTimeFormatter.format(Math.round(diff / 60), "minute");
}

export function formatAbsoluteTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// One file's diff at one commit, opened through whichever editor the app's
// `editor` setting selects. Shared by both views.
export async function openCommitFileDiff(
  root: string,
  relPath: string,
  hash: string,
  oldPath?: string | null,
): Promise<void> {
  if (!openDiffInEditor) return;
  const params = new URLSearchParams({ cwd: root, path: relPath, hash });
  if (oldPath) params.set("oldPath", oldPath);
  try {
    const sides = await apiGetJson<{
      original: { content: string; label: string };
      modified: { content: string; label: string; readOnlyReason?: string };
    }>(`/diff-sides?${params}`);
    await openDiffInEditor({
      title: `${basenameOf(relPath)} (${shortHash(hash)})`,
      original: sides.original,
      modified: sides.modified,
    });
  } catch {
    // A revision git can't produce (a shallow clone, a pruned object) isn't
    // worth an error surface of its own: the row stays where it is.
  }
}

// ---- Repo membership, for the FILES-tree menu ----
//
// isVisible is called synchronously while the menu is being built, but "is
// this inside a repository?" needs a git call. So the answer is cached per
// DIRECTORY (every file in a folder shares it): a hit answers immediately, a
// miss starts the lookup and hides the items until the next right-click. The
// active session's directory is looked up on every context change, which
// covers the common case before the user ever opens the menu.
const repoRoots = new Map<string, string | null>();
const pending = new Set<string>();

function lookupRepo(dir: string): void {
  if (!dir || repoRoots.has(dir) || pending.has(dir)) return;
  pending.add(dir);
  void apiGetJson<{ root: string | null }>(`/repo?cwd=${encodeURIComponent(dir)}`)
    .then((data) => repoRoots.set(dir, data.root))
    .catch(() => repoRoots.set(dir, null))
    .finally(() => pending.delete(dir));
}

function repoFor(filePath: string): string | null {
  const dir = dirnameOf(filePath);
  if (!repoRoots.has(dir)) {
    lookupRepo(dir);
    return null;
  }
  return repoRoots.get(dir) ?? null;
}

// ---- activate ----

interface ExtensionContext {
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    mode?: "default" | "preview";
    component: typeof HistoryView | typeof BlameView;
  }): void;
  registerFileMenuItem?(item: {
    id: string;
    label: string;
    icon?: string;
    order?: number;
    isVisible: (path: string, isDir: boolean) => boolean;
    onClick: (path: string) => void;
  }): void;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
    openFileTab(path: string): void;
    openDiff?(req: DiffRequest): Promise<boolean>;
    getThemeColors?(): Record<string, string>;
    getTokenColors?(): unknown[];
    onDidChangeColorTheme?(cb: () => void): () => void;
  };
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  openViewerTab = ctx.app.openViewerTab.bind(ctx.app);
  openFileTab = ctx.app.openFileTab.bind(ctx.app);
  openDiffInEditor = ctx.app.openDiff ? ctx.app.openDiff.bind(ctx.app) : null;
  assetUrl = ctx.assetUrl;
  themeApi = ctx.app;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  // extensions: [] — never matched from a file extension; every open goes
  // through openViewerTab, so a plain FILES-tree click keeps opening the
  // file in the editor as before.
  ctx.registerFileViewer({ id: "history", extensions: [], component: HistoryView });
  ctx.registerFileViewer({ id: "blame", extensions: [], component: BlameView });

  ctx.registerFileMenuItem?.({
    id: "history",
    label: "Git: File History",
    icon: "history",
    order: 50,
    isVisible: (path, isDir) => !isDir && repoFor(path) !== null,
    onClick: (path) => {
      const root = repoFor(path);
      if (!root) return;
      openViewerTab?.("history", encodeKey(root, relative(root, path)), {
        title: `History · ${basenameOf(path)}`,
      });
    },
  });

  ctx.registerFileMenuItem?.({
    id: "blame",
    label: "Git: Blame",
    icon: "account",
    order: 51,
    isVisible: (path, isDir) => !isDir && repoFor(path) !== null,
    onClick: (path) => {
      const root = repoFor(path);
      if (!root) return;
      openViewerTab?.("blame", encodeKey(root, relative(root, path)), {
        title: `Blame · ${basenameOf(path)}`,
      });
    },
  });

  lookupRepo(ctx.app.getActiveContext().cwd ?? "");
  removeContextListener = ctx.app.onDidChangeContext((next) => lookupRepo(next.cwd ?? ""));
}

// The host hands absolute paths; the server takes paths relative to the repo
// root. No path module in the browser, and both sides are POSIX here.
function relative(root: string, absPath: string): string {
  const withSep = root.endsWith("/") ? root : `${root}/`;
  return absPath.startsWith(withSep) ? absPath.slice(withSep.length) : absPath;
}

export function deactivate(): void {
  stopThemeTracking();
  assetUrl = null;
  themeApi = null;
  removeStylesheet?.();
  removeStylesheet = null;
  removeContextListener?.();
  removeContextListener = null;
  serverFetch = null;
  openViewerTab = null;
  openFileTab = null;
  openDiffInEditor = null;
  repoRoots.clear();
  pending.clear();
}
