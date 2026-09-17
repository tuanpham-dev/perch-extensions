// agent-monitor: every terminal window running one of the agents in the app's own
// registry (Settings → AI Providers), classified working/waiting/done/idle and
// shown as a status mark on that window's own PROJECTS-pane row, in Orca's
// vocabulary: a spinner, an amber "?", an emerald dot, a red dot for a turn
// that was interrupted, and a gray dot for idle. Host hooks arrive
// via module-level bridge variables set once in activate(), same pattern as
// every other bundled-style extension (search, git-scm, worktrees).
//
// No settings section of its own any more: the hook snippet, the install
// button and the "have any events arrived" readout all live in core's
// Settings → AI Providers now, for every agent at once rather than for Claude
// Code alone (plans/agent-platform-core.md).
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";

// ---- Module-level host bridge ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let removeStylesheet: (() => void) | null = null;

// ---- Types (mirror server.js's /agents response) ----

interface AgentRow {
  sessionName: string;
  windowIndex: number;
  windowName: string;
  command: string;
  cwd: string;
  // idle: quiet for 30 minutes without reporting that it finished, or no
  // signal at all for this pane.
  state: "working" | "waiting" | "done" | "idle";
  // A done turn the user cancelled (the stop hook's is_interrupt).
  interrupted?: boolean;
  // Why the agent is waiting: a permission prompt, or a question it asked
  // the user (Claude's AskUserQuestion, Codex's request_user_input). Both
  // block on a human and both get the "?" badge.
  stateDetail?: "permission" | "question";
  taskLabel?: string;
  // From the hooks, when they are installed: the turn's prompt and the tool
  // in flight - Orca's readout, so the tooltip says what the agent is doing
  // rather than only that it is doing something.
  prompt?: string;
  toolName?: string;
  lastActivityAt: number | null;
}

async function fetchAgents(): Promise<AgentRow[]> {
  if (!serverFetch) return [];
  const res = await serverFetch("/agents");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { agents: AgentRow[] };
  return body.agents;
}

function rowKey(row: AgentRow): string {
  return `${row.sessionName}:${row.windowIndex}`;
}

// ---- Window-row decoration (PROJECTS pane) ----
//
// This app is designed 1 window per tab, so a (sessionName, windowIndex)
// pair identifies at most one agent pane in practice — no merge rule needed
// for multiple agents sharing a row. Every agent window gets a mark, done
// included: Orca's sidebar shows a finished agent as an emerald dot, and
// that is exactly the "which of my agents can I look at now" answer. Only a
// window that is not an agent (a plain shell) has none, because the server
// never lists it.
let agentsByWindowKey = new Map<string, AgentRow>();
let refreshDecorations: (() => void) | null = null;

type Mark = "working" | "waiting" | "done" | "interrupted" | "idle";

function markFor(row: AgentRow): Mark {
  if (row.state === "done") return row.interrupted ? "interrupted" : "done";
  return row.state;
}

function labelFor(row: AgentRow, mark: Mark): string {
  // The tool is the most useful word in an attention state: "permission:
  // Bash" says what is being asked, where "permission" alone only says that
  // something is.
  const tool = row.toolName ? `: ${row.toolName}` : "";
  switch (mark) {
    case "working":
      return row.toolName ? `Working - ${row.toolName}` : "Working";
    case "waiting":
      return row.stateDetail === "permission"
        ? `Waiting on you - permission${tool}`
        : row.stateDetail === "question"
          ? "Waiting on you - question"
          : "Waiting on you";
    case "done":
      return "Done";
    case "interrupted":
      return "Interrupted";
    case "idle":
      return "Idle";
  }
}

function decorationFor(row: AgentRow | undefined): { badge: string; tooltip: string; className: string } | undefined {
  if (!row) return undefined;
  const mark = markFor(row);
  const label = labelFor(row, mark);
  // The task label from the title, else the prompt from the hook: what the
  // agent is on, in one line.
  const context = row.taskLabel ?? row.prompt;
  return {
    // Shape first, color second. Waiting is the one state blocking YOU, so
    // it is a "?" rather than another shade of dot, and working is a spinner:
    // both read before their color does. The dots' "●" is hidden by the
    // stylesheet; it is only there so the badge is never empty.
    badge: mark === "waiting" ? "?" : "●",
    tooltip: context ? `${label} - ${context}` : label,
    className: `agent-monitor-badge-${mark}`,
  };
}

// ---- Activation ----

interface SessionDecorationContext {
  sessionName: string;
  windowIndex: number;
  cwd: string;
  command: string;
}

interface ExtensionContext {
  registerSessionDecorationProvider(provider: {
    id: string;
    provideWindowDecoration: (
      ctx: SessionDecorationContext,
    ) => { badge: string; tooltip?: string; className?: string } | undefined;
  }): { refresh(): void };
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
}

const POLL_MS = 10_000;
let pollTimer: number | null = null;

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  refreshDecorations = ctx.registerSessionDecorationProvider({
    id: "agents",
    provideWindowDecoration(win) {
      return decorationFor(agentsByWindowKey.get(`${win.sessionName}:${win.windowIndex}`));
    },
  }).refresh;

  const poll = () => {
    fetchAgents()
      .then((rows) => {
        agentsByWindowKey = new Map(rows.map((r) => [rowKey(r), r]));
        refreshDecorations?.();
      })
      .catch(() => {
        // Transient — next poll retries.
      });
  };
  poll();
  pollTimer = window.setInterval(poll, POLL_MS);
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  refreshDecorations = null;
  agentsByWindowKey = new Map();
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}
