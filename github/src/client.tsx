// github: a GITHUB sidebar tab listing the active repo's pull requests and
// issues via the `gh` CLI (Mine/All and state filters, paged with Load
// more), with a "Start work" action per row that creates a worktree session
// for it - or opens the one it already has - optionally priming an agent. Host
// hooks arrive via module-level bridge variables set once in activate() —
// same pattern every bundled-style extension in the main repo uses.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import Icon from "./Icon";
import { resolveAgentPresets, sendToAgent, type AgentLaunchPreset } from "./agentTarget";

// ---- Module-level host bridge ----

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let getActiveContext: (() => ActiveContext) | null = null;
let onDidChangeContext: ((cb: (ctx: ActiveContext) => void) => () => void) | null = null;
let openSessionWindow: ((sessionName: string, opts?: { createCwd?: string }) => void) | null = null;
let extSettings: SettingsApi | null = null;
let removeStylesheet: (() => void) | null = null;

// The subset of the host's MenuItem / SidebarPanelHostProps this panel uses
// (structural copies of client/src/types.ts in the main perch repo).
interface MenuItem {
  label: string;
  onClick: () => void;
}

interface SidebarPanelHostProps {
  actionsTarget?: HTMLDivElement | null;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
}

// ---- Types (mirror server.js's responses) ----

// What went wrong, as server.js names it (classifyGhError in ghModel.mjs).
type ProblemKind = "gh-missing" | "network" | "auth" | "not-github" | "gh";

interface Problem {
  kind: ProblemKind | null;
  message: string;
  detail?: string;
}

interface StatusResponse {
  authed: boolean;
  repo: string | null;
  problem: Problem | null;
}

interface PrRow {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  updatedAt: string;
  isDraft: boolean;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isCrossRepository?: boolean;
  headRepositoryOwner?: { login: string } | null;
}

interface IssueRow {
  number: number;
  title: string;
  author: { login: string };
  updatedAt: string;
  url: string;
  state: "OPEN" | "CLOSED";
}

interface WorktreeResult {
  path: string;
  branch: string;
  reused: boolean;
  session: string | null;
  note?: string | null;
}

interface ExistingResult {
  worktree: { path: string; branch: string } | null;
  session: string | null;
}

type Scope = "all" | "mine";
type PrState = "open" | "closed" | "merged" | "all";
type IssueState = "open" | "closed" | "all";

// Same page size as the server's (ghModel.mjs PAGE_SIZE): "Load more" asks
// for this many more rows each time.
const PAGE_SIZE = 30;

// ---- Fetch helpers ----

// Carries the server's `kind`, so a failed list can say which problem it is.
class ApiError extends Error {
  kind: ProblemKind | null;
  detail?: string;
  constructor(message: string, kind: ProblemKind | null, detail?: string) {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let kind: ProblemKind | null = null;
    let detail: string | undefined;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
      if (typeof body?.kind === "string") kind = body.kind as ProblemKind;
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new ApiError(message, kind, detail);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function apiGet<T>(path: string): Promise<T> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch(path).then((res) => readJson<T>(res));
}

function apiPost<T>(path: string, body: unknown): Promise<T> {
  if (!serverFetch) return Promise.reject(new Error("extension not activated"));
  return serverFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => readJson<T>(res));
}

function problemOf(err: unknown): Problem {
  if (err instanceof ApiError) return { kind: err.kind, message: err.message, detail: err.detail };
  return { kind: null, message: err instanceof Error ? err.message : String(err) };
}

function query(params: Record<string, string | number | boolean>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("&");
}

// ---- Helpers ----

// Byte-identical to the bundled worktrees extension's own sessionNameFor (and
// ghModel.mjs's) — Session names can't contain "." or ":".
function sessionNameFor(branch: string): string {
  return branch.replace(/[.:/\s]+/g, "-").replace(/^-+|-+$/g, "");
}

function shortSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "untitled";
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Which agents "Start work" can launch comes from the app's own registry
// (Settings → AI Providers), shared with every other extension that needs to know
// what an agent is. This extension's own github.agents setting is gone
// rather than deprecated: keeping an override for one version was the
// cautious option, and it was dropped deliberately so there is exactly one
// place an agent is defined - and there is no fallback list here either: on
// a core without the registry, resolveAgentPresets rejects.
function agentPresets(): Promise<AgentLaunchPreset[]> {
  return resolveAgentPresets();
}

function readSendAutoSubmit(): boolean {
  return extSettings?.get("github.sendAutoSubmit") === true;
}

const PROBLEM_TITLES: Record<ProblemKind, string> = {
  "gh-missing": "gh is not installed",
  network: "Can't reach GitHub",
  auth: "Not signed in to GitHub",
  "not-github": "Not a GitHub repository",
  gh: "gh failed",
};

// One problem, named: a title for its kind, the server's sentence, and gh's
// own first line beneath when it adds something.
function ProblemView({ problem }: { problem: Problem }) {
  return (
    <div className="github-error" role="alert">
      {problem.kind && <div className="github-error-title">{PROBLEM_TITLES[problem.kind]}</div>}
      <div>{problem.message}</div>
      {problem.detail && problem.detail !== problem.message && (
        <div className="github-error-detail">{problem.detail}</div>
      )}
    </div>
  );
}

function emptyText(what: string, state: string, scope: Scope): string {
  const which = state === "all" ? "" : `${state} `;
  return `No ${which}${what}${scope === "mine" ? " for you" : ""}.`;
}

// ---- GitHubPanel (registerSidebarPanel component) ----

// One list section's paging and freshness. `seq` is bumped by every request,
// and a reply whose number is no longer current is dropped: a slow reply for
// the old filter (or the old repo) must never overwrite the new one.
function useListLoader<Row>(
  route: "prs" | "issues",
  pick: (body: Record<string, unknown>) => Row[],
  params: { cwd: string | null; repo: string | null; scope: Scope; state: string; reloadToken: number },
) {
  const { cwd, repo, scope, state, reloadToken } = params;
  const [rows, setRows] = useState<Row[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const seq = useRef(0);
  const limit = useRef(PAGE_SIZE);
  const filterKey = useRef("");

  const load = useCallback(
    async (wanted: number) => {
      const mine = ++seq.current;
      if (!cwd || !repo) {
        setRows([]);
        setHasMore(false);
        setProblem(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const body = await apiGet<Record<string, unknown>>(
          `/${route}?${query({ cwd, state, mine: scope === "mine" ? 1 : 0, limit: wanted })}`,
        );
        if (mine !== seq.current) return;
        limit.current = wanted;
        setRows(pick(body));
        setHasMore(body.hasMore === true);
        setProblem(null);
      } catch (err) {
        if (mine !== seq.current) return;
        setProblem(problemOf(err));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    // `pick` is a module-level function at every call site, so it never
    // changes between renders.
    [route, pick, cwd, repo, scope, state],
  );

  // A changed filter or repo starts again from the first page; a Refresh
  // reloads as many rows as are showing.
  useEffect(() => {
    const key = `${cwd}|${repo}|${scope}|${state}`;
    if (key !== filterKey.current) {
      filterKey.current = key;
      limit.current = PAGE_SIZE;
    }
    void load(limit.current);
  }, [load, cwd, repo, scope, state, reloadToken]);

  const loadMore = useCallback(() => void load(limit.current + PAGE_SIZE), [load]);
  return { rows, hasMore, loading, problem, loadMore };
}

const pickPrs = (body: Record<string, unknown>) => (Array.isArray(body.prs) ? (body.prs as PrRow[]) : []);
const pickIssues = (body: Record<string, unknown>) => (Array.isArray(body.issues) ? (body.issues as IssueRow[]) : []);

function GitHubPanel({ showMenu, actionsTarget }: SidebarPanelHostProps) {
  const [cwd, setCwd] = useState<string | null>(() => getActiveContext?.().cwd ?? null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusProblem, setStatusProblem] = useState<Problem | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [scope, setScope] = useState<Scope>("all");
  const [prState, setPrState] = useState<PrState>("open");
  const [issueState, setIssueState] = useState<IssueState>("open");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const statusSeq = useRef(0);
  const statusCwd = useRef<string | null>(null);

  useEffect(() => {
    if (!onDidChangeContext) return;
    return onDidChangeContext((ctx) => setCwd(ctx.cwd));
  }, []);

  // The repo (and whether gh can reach it) for the active window. A new
  // window clears what was showing; a Refresh keeps it on screen until the
  // answer arrives. Guarded like the lists: only the latest reply counts.
  useEffect(() => {
    const mine = ++statusSeq.current;
    if (statusCwd.current !== cwd) {
      statusCwd.current = cwd;
      setStatus(null);
      setStatusProblem(null);
    }
    if (!cwd) {
      setStatusLoading(false);
      return;
    }
    setStatusLoading(true);
    apiGet<StatusResponse>(`/status?${query({ cwd })}`)
      .then((s) => {
        if (mine !== statusSeq.current) return;
        setStatus(s);
        setStatusProblem(null);
      })
      .catch((err) => {
        if (mine !== statusSeq.current) return;
        setStatusProblem(problemOf(err));
      })
      .finally(() => {
        if (mine === statusSeq.current) setStatusLoading(false);
      });
  }, [cwd, reloadToken]);

  const repo = status?.repo ?? null;
  const prList = useListLoader<PrRow>("prs", pickPrs, { cwd, repo, scope, state: prState, reloadToken });
  const issueList = useListLoader<IssueRow>("issues", pickIssues, { cwd, repo, scope, state: issueState, reloadToken });

  const refresh = useCallback(() => {
    setStartError(null);
    setReloadToken((t) => t + 1);
  }, []);

  const loadingAny = statusLoading || prList.loading || issueList.loading;

  // `preset` undefined means "not chosen yet": the registry couldn't be read
  // when the button was clicked, so it is read again here and a core without
  // it fails after the worktree exists, as before the picker.
  const startWork = useCallback(
    async (kind: "issue" | "pr", number: number, title: string, preset: AgentLaunchPreset | null | undefined) => {
      if (!cwd) return;
      const what = kind === "pr" ? `PR #${number}` : `issue #${number}`;
      const branch = kind === "issue" ? `issue-${number}-${shortSlug(title)}` : `pr-${number}`;
      setBusyKey(`${kind}-${number}`);
      setStartError(null);
      setNote(null);
      try {
        const result = await apiPost<WorktreeResult>("/worktree", { cwd, branch, kind, number });
        // Already being worked on: switch to that session rather than
        // starting a second agent beside the first.
        if (result.session) {
          openSessionWindow?.(result.session);
          setNote(`Opened the existing session for ${what}.`);
          return;
        }
        const sessionName = sessionNameFor(result.branch);
        openSessionWindow?.(sessionName, { createCwd: result.path });
        // A reused worktree, a fallback base or a reused branch is worth
        // saying out loud - the worktree is real either way, but not quite
        // what the user expected.
        if (result.reused) setNote(`Reused ${what}'s existing worktree at ${result.path}.`);
        else if (result.note) setNote(result.note);

        if (preset === undefined) preset = (await agentPresets())[0] ?? null;
        if (preset) {
          await sendToAgent(sessionName, preset.command, true, { retries: 12, retryDelayMs: 400 });
          const brief = await apiGet<{ text: string }>(`/brief?${query({ cwd, kind, number })}`);
          await sendToAgent(sessionName, brief.text, readSendAutoSubmit(), { retries: 6, retryDelayMs: 400 });
        }
      } catch (err) {
        setStartError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [cwd],
  );

  // A PR or issue with a session already open on it goes straight there - no
  // agent picker, no second worktree. Otherwise, with more than one agent in
  // the registry, Start work asks which to use instead of silently taking the
  // first (same as the sibling jira extension): offering only entry [0] made
  // every other agent unreachable. One agent, or no showMenu from the host,
  // keeps the direct path.
  const handleStartClick = useCallback(
    async (
      kind: "issue" | "pr",
      row: { number: number; title: string; headRefName?: string; isCrossRepository?: boolean },
      event: { clientX: number; clientY: number },
    ) => {
      // Read before awaiting: the menu is placed at the click.
      const { clientX, clientY } = event;
      const { number, title } = row;
      if (cwd) {
        try {
          const existing = await apiGet<ExistingResult>(
            `/existing?${query({
              cwd,
              kind,
              number,
              head: row.headRefName ?? "",
              cross: row.isCrossRepository ? 1 : 0,
            })}`,
          );
          if (existing.session) {
            setStartError(null);
            openSessionWindow?.(existing.session);
            setNote(`Opened the existing session for ${kind === "pr" ? "PR" : "issue"} #${number}.`);
            return;
          }
        } catch {
          // Can't tell - fall through; the worktree route checks again.
        }
      }
      let presets: AgentLaunchPreset[];
      try {
        presets = await agentPresets();
      } catch {
        void startWork(kind, number, title, undefined);
        return;
      }
      if (presets.length <= 1 || !showMenu) {
        void startWork(kind, number, title, presets[0] ?? null);
        return;
      }
      showMenu(clientX, clientY, [
        ...presets.map((preset) => ({
          label: preset.name,
          onClick: () => void startWork(kind, number, title, preset),
        })),
        { label: "No agent (worktree only)", onClick: () => void startWork(kind, number, title, null) },
      ]);
    },
    [cwd, showMenu, startWork],
  );

  const refreshButton = (
    <button className="icon-button" title="Refresh" aria-label="Refresh" disabled={!cwd} onClick={refresh}>
      <Icon name={loadingAny ? "loading" : "refresh"} />
    </button>
  );
  // Beside the panel title when the host offers a slot for it, else at the
  // top of the body.
  const actions = actionsTarget ? createPortal(refreshButton, actionsTarget) : null;
  const inlineBar = actionsTarget ? null : <div className="github-toolbar">{refreshButton}</div>;

  const body = (() => {
    if (!cwd) return <div className="github-empty">No active window.</div>;
    if (statusProblem) return <ProblemView problem={statusProblem} />;
    if (!status) return <div className="github-empty">Loading…</div>;
    if (status.problem) return <ProblemView problem={status.problem} />;
    if (!status.repo) {
      return <ProblemView problem={{ kind: "not-github", message: "gh found no GitHub repository for this folder." }} />;
    }
    return (
      <>
        {startError && <div className="github-error">{startError}</div>}
        {note && <div className="github-empty">{note}</div>}
        <div className="github-filters" role="group" aria-label="Whose pull requests and issues">
          {(["all", "mine"] as const).map((value) => (
            <button
              key={value}
              className={`github-chip${scope === value ? " github-chip-on" : ""}`}
              aria-pressed={scope === value}
              title={value === "mine" ? "Pull requests you opened, and issues assigned to you" : "Everyone's"}
              onClick={() => setScope(value)}
            >
              {value === "mine" ? "Mine" : "All"}
            </button>
          ))}
        </div>

        <div className="github-section-header">
          <span>PULL REQUESTS</span>
          <select
            className="github-state"
            aria-label="Pull request state"
            value={prState}
            onChange={(e) => setPrState(e.target.value as PrState)}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="merged">Merged</option>
            <option value="all">All</option>
          </select>
        </div>
        {prList.problem && <ProblemView problem={prList.problem} />}
        {!prList.problem && !prList.loading && prList.rows.length === 0 && (
          <div className="github-empty">{emptyText("pull requests", prState, scope)}</div>
        )}
        <ul className="github-list">
          {prList.rows.map((pr) => {
            const key = `pr-${pr.number}`;
            const fork = pr.isCrossRepository && pr.headRepositoryOwner?.login ? pr.headRepositoryOwner.login : null;
            return (
              <li key={pr.number} className="github-row">
                <a className="github-row-main" href={pr.url} target="_blank" rel="noopener noreferrer">
                  <span className="github-number">#{pr.number}</span>
                  <span className="github-title">
                    {pr.isDraft ? "[Draft] " : ""}
                    {pr.title}
                  </span>
                  <span className="github-meta">
                    {pr.state && pr.state !== "OPEN" ? `${pr.state.toLowerCase()} · ` : ""}
                    {pr.author.login}
                    {fork && fork !== pr.author.login ? ` (${fork})` : ""} · {relativeTime(pr.updatedAt)}
                  </span>
                </a>
                <button
                  className="icon-button"
                  title={
                    fork
                      ? `Start work: check out this PR from ${fork}'s fork in a worktree session (or open the one it has)`
                      : "Start work: create a worktree session for this PR (or open the one it has)"
                  }
                  disabled={busyKey === key}
                  onClick={(e) => void handleStartClick("pr", pr, e)}
                >
                  <Icon name={busyKey === key ? "loading" : "git-branch"} />
                </button>
              </li>
            );
          })}
        </ul>
        {prList.hasMore && (
          <button className="github-more" disabled={prList.loading} onClick={prList.loadMore}>
            {prList.loading ? "Loading…" : "Load more"}
          </button>
        )}

        <div className="github-section-header">
          <span>ISSUES</span>
          <select
            className="github-state"
            aria-label="Issue state"
            value={issueState}
            onChange={(e) => setIssueState(e.target.value as IssueState)}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </div>
        {issueList.problem && <ProblemView problem={issueList.problem} />}
        {!issueList.problem && !issueList.loading && issueList.rows.length === 0 && (
          <div className="github-empty">{emptyText("issues", issueState, scope)}</div>
        )}
        <ul className="github-list">
          {issueList.rows.map((issue) => {
            const key = `issue-${issue.number}`;
            return (
              <li key={issue.number} className="github-row">
                <a className="github-row-main" href={issue.url} target="_blank" rel="noopener noreferrer">
                  <span className="github-number">#{issue.number}</span>
                  <span className="github-title">{issue.title}</span>
                  <span className="github-meta">
                    {issue.state && issue.state !== "OPEN" ? `${issue.state.toLowerCase()} · ` : ""}
                    {issue.author.login} · {relativeTime(issue.updatedAt)}
                  </span>
                </a>
                <button
                  className="icon-button"
                  title="Start work: create a worktree session for this issue (or open the one it has)"
                  disabled={busyKey === key}
                  onClick={(e) => void handleStartClick("issue", issue, e)}
                >
                  <Icon name={busyKey === key ? "loading" : "git-branch"} />
                </button>
              </li>
            );
          })}
        </ul>
        {issueList.hasMore && (
          <button className="github-more" disabled={issueList.loading} onClick={issueList.loadMore}>
            {issueList.loading ? "Loading…" : "Load more"}
          </button>
        )}
      </>
    );
  })();

  return (
    <div className="github-panel">
      {actions}
      {inlineBar}
      {body}
    </div>
  );
}

// ---- Activation ----

interface ExtensionContext {
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location?: "tab" | "explorer" | "run" | "commands";
    focusBinding?: string;
    component: (props: SidebarPanelHostProps) => ReturnType<typeof GitHubPanel>;
  }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  settings: SettingsApi;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
    openSessionWindow(sessionName: string, opts?: { createCwd?: string }): void;
  };
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  getActiveContext = ctx.app.getActiveContext;
  onDidChangeContext = ctx.app.onDidChangeContext;
  openSessionWindow = ctx.app.openSessionWindow;
  extSettings = ctx.settings;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerSidebarPanel({
    id: "github",
    title: "GitHub",
    icon: "github",
    component: GitHubPanel,
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
}
