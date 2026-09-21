// git-graph: a GRAPH tab for the active repository — every branch's commits
// as a lane graph, with the operations a commit or a ref label invites.
//
// It opens in the editor area rather than the sidebar because a DAG with ref
// labels needs the width. One tab per repository: re-running the command
// focuses the tab that is already open for that repo.
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import GraphView from "./GraphView";

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

export interface SettingsApi {
  get(key: string): unknown;
  // Writes one of this extension's own settings - the same store the
  // Settings UI edits - so the tree/list toggle IS the setting, not a
  // second copy of it.
  set?(key: string, value: unknown): void;
  onDidChange(cb: () => void): () => void;
}

export let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
export let openViewerTab: ((viewerId: string, path: string, opts?: { title?: string }) => void) | null = null;
export let openDiffInEditor: ((req: DiffRequest) => Promise<boolean>) | null = null;
export let confirmDialog: ((message: string, confirmLabel?: string) => Promise<boolean>) | null = null;
export let promptDialog: ((message: string, defaultValue?: string) => Promise<string | null>) | null = null;
export let extSettings: SettingsApi | null = null;

let removeStylesheet: (() => void) | null = null;
let removeContextListener: (() => void) | null = null;

// ---- Fetch helpers ----

export class ApiError extends Error {
  unmerged?: boolean;
  constructor(message: string, unmerged?: boolean) {
    super(message);
    this.unmerged = unmerged;
  }
}

export async function apiGetJson<T>(path: string): Promise<T> {
  const res = await serverFetch!(path);
  const data = await res.json().catch(() => ({}) as Record<string, never>);
  if (!res.ok) throw new ApiError((data as { error?: string }).error || `${res.status} ${res.statusText}`);
  return data as T;
}

export async function apiPost<T = { ok: boolean; conflicted?: boolean }>(path: string, body: unknown): Promise<T> {
  const res = await serverFetch!(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}) as Record<string, never>);
  if (!res.ok) {
    throw new ApiError(
      (data as { error?: string }).error || `${res.status} ${res.statusText}`,
      (data as { unmerged?: boolean }).unmerged,
    );
  }
  return data as T;
}

// ---- Formatting ----

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

export function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
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

export function readPollInterval(): number {
  const raw = Number(extSettings?.get("gitGraph.pollInterval"));
  if (!Number.isFinite(raw) || raw <= 0) return 5000;
  return Math.max(1000, raw);
}

export function readShowRemotes(): boolean {
  return extSettings?.get("gitGraph.showRemoteBranches") !== false;
}

export function readShowTags(): boolean {
  return extSettings?.get("gitGraph.showTags") !== false;
}

export function readShowStashes(): boolean {
  return extSettings?.get("gitGraph.showStashes") !== false;
}

export function readFirstParent(): boolean {
  return extSettings?.get("gitGraph.firstParent") === true;
}

// How many commits one page of the graph holds - the first load and every
// Load More after it.
export function readPageSize(): number {
  const raw = Number(extSettings?.get("gitGraph.commitsPerPage"));
  if (!Number.isFinite(raw) || raw <= 0) return 300;
  return Math.min(5000, Math.max(50, Math.round(raw)));
}

export function readDateStyle(): "relative" | "absolute" {
  return extSettings?.get("gitGraph.dateStyle") === "absolute" ? "absolute" : "relative";
}

export function readShowHash(): boolean {
  return extSettings?.get("gitGraph.showHashColumn") !== false;
}

export function readShowUncommitted(): boolean {
  return extSettings?.get("gitGraph.showUncommittedChanges") !== false;
}

export function readFileView(): "list" | "tree" {
  return extSettings?.get("gitGraph.fileView") === "tree" ? "tree" : "list";
}

export function writeFileView(view: "list" | "tree"): void {
  extSettings?.set?.("gitGraph.fileView", view);
}

// Bumped whenever any setting changes, so a view that reads settings during
// render re-reads them: the host applies a settings change live, and a graph
// that only noticed on remount would sit there showing the old page size.
export function useSettingsRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => extSettings?.onDidChange(() => setRevision((n) => n + 1)), []);
  return revision;
}

// ---- Repo tracking ----
//
// The status-bar launcher has to know, without being asked, whether the
// active directory is a repository; the command needs the same answer when
// it runs. One lookup per directory, refreshed on every context change.

let activeRoot: string | null = null;
const rootListeners = new Set<(root: string | null) => void>();
const repoRoots = new Map<string, string | null>();

export function onActiveRootChange(cb: (root: string | null) => void): () => void {
  rootListeners.add(cb);
  return () => rootListeners.delete(cb);
}

export function getActiveRoot(): string | null {
  return activeRoot;
}

function setActiveRoot(root: string | null) {
  if (root === activeRoot) return;
  activeRoot = root;
  rootListeners.forEach((cb) => cb(root));
}

async function resolveRoot(cwd: string | null): Promise<void> {
  if (!cwd) {
    setActiveRoot(null);
    return;
  }
  if (repoRoots.has(cwd)) {
    setActiveRoot(repoRoots.get(cwd) ?? null);
    return;
  }
  try {
    const data = await apiGetJson<{ root: string | null }>(`/repo?cwd=${encodeURIComponent(cwd)}`);
    repoRoots.set(cwd, data.root);
    setActiveRoot(data.root);
  } catch {
    repoRoots.set(cwd, null);
    setActiveRoot(null);
  }
}

// One tab per repository: the viewer key IS the root, so re-opening focuses
// the tab that already exists rather than stacking a second one.
export function openGraphForRoot(root: string) {
  openViewerTab?.("graph", root, { title: `Graph · ${basenameOf(root)}` });
}

// ---- Status-bar launcher ----

import { useEffect, useState } from "react";
import Icon from "./Icon";

function GraphStatusItem() {
  const [root, setRoot] = useState<string | null>(() => getActiveRoot());
  useEffect(() => onActiveRootChange(setRoot), []);
  // Hidden outside a repository: a button that can't do anything is worse
  // than no button.
  if (!root) return null;
  return (
    <button
      className="status-bar-item"
      title={`Open the graph for ${basenameOf(root)}`}
      onClick={() => openGraphForRoot(root)}
    >
      <Icon name="git-commit" />
    </button>
  );
}

// ---- activate ----

interface ExtensionContext {
  registerFileViewer(viewer: {
    id: string;
    extensions: string[];
    mode?: "default" | "preview";
    component: typeof GraphView;
  }): void;
  registerCommand(cmd: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  registerStatusBarItem?(item: {
    id: string;
    title?: string;
    placement?: "left" | "right";
    order?: number;
    component: typeof GraphStatusItem;
  }): void;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    openViewerTab(viewerId: string, path: string, opts?: { title?: string }): void;
    openDiff?(req: DiffRequest): Promise<boolean>;
    confirmDialog?(message: string, confirmLabel?: string): Promise<boolean>;
    promptDialog?(message: string, defaultValue?: string): Promise<string | null>;
  };
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  settings: SettingsApi;
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  openViewerTab = ctx.app.openViewerTab.bind(ctx.app);
  openDiffInEditor = ctx.app.openDiff ? ctx.app.openDiff.bind(ctx.app) : null;
  confirmDialog = ctx.app.confirmDialog ? ctx.app.confirmDialog.bind(ctx.app) : null;
  promptDialog = ctx.app.promptDialog ? ctx.app.promptDialog.bind(ctx.app) : null;
  extSettings = ctx.settings;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  // extensions: [] — the graph is never matched to a file; it is reached
  // only through openViewerTab, keyed by the repository root.
  ctx.registerFileViewer({ id: "graph", extensions: [], component: GraphView });

  ctx.registerCommand({
    id: "open",
    label: "Git Graph: Open",
    defaultBinding: "ctrl+shift+alt+KeyG",
    run: () => {
      const root = getActiveRoot();
      if (root) openGraphForRoot(root);
    },
  });

  ctx.registerStatusBarItem?.({
    id: "graph",
    title: "Git Graph",
    placement: "left",
    // After git-scm's branch readout, which is the thing you glance at.
    order: 1,
    component: GraphStatusItem,
  });

  void resolveRoot(ctx.app.getActiveContext().cwd);
  removeContextListener = ctx.app.onDidChangeContext((next) => void resolveRoot(next.cwd));
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  removeContextListener?.();
  removeContextListener = null;
  serverFetch = null;
  openViewerTab = null;
  openDiffInEditor = null;
  confirmDialog = null;
  promptDialog = null;
  extSettings = null;
  activeRoot = null;
  rootListeners.clear();
  repoRoots.clear();
}
