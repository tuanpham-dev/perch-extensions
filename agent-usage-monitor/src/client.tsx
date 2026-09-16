// Agent Usage Monitor's client: three status-bar items and the view behind
// them. Everything shown is read server-side from what the agents write
// locally (see ../readers/*) — this file polls, formats and lays out.
//
// Items: one per agent that reports limits (Claude, Codex), each switchable
// in Settings, plus the model running in the active terminal.
import { useCallback, useEffect, useMemo, useState } from "react";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import { modelLabel } from "./modelLabel";

// ---- Host bridge ----

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
let settingsApi: SettingsApi | null = null;
let appApi: {
  getActiveContext(): ActiveContext;
  onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
} | null = null;
let removeStylesheet: (() => void) | null = null;

// ---- Payload (mirrors server.js) ----

interface ModelTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

interface UsageBlock {
  start: number;
  end: number;
  isCurrent: boolean;
  perModel: Record<string, ModelTotals>;
  total: ModelTotals;
  firstAt: number;
  lastAt: number;
}

interface LimitWindow {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  // A slice of another window rather than a window of its own - Claude's
  // per-model weekly cap sits inside the account's week, and resets with it.
  scoped?: boolean;
  // The model that slice belongs to ("Fable"), which is what the bar shows
  // in place of a countdown it would only be repeating.
  scope?: string | null;
}

interface Spend {
  supported: boolean;
  today?: number;
  last7Days?: number;
  partial?: boolean;
  sessions?: number;
}

interface AgentUsage {
  id: string;
  label: string;
  // The plan the agent reports for the account, when it names one.
  plan?: string | null;
  // The agent's own mark, from core's registry: a URL, with a codicon name
  // to fall back on. Empty for an agent that declared neither.
  iconUrl?: string;
  icon?: string;
  blocks: UsageBlock[];
  limits: LimitWindow[];
  spend: Spend;
  notes: string[];
}

interface UsageResponse {
  agents: AgentUsage[];
}

interface ModelResponse {
  agentId?: string;
  label?: string;
  model?: string;
}

const USAGE_POLL_MS = 30_000;
const MODEL_POLL_MS = 15_000;

async function fetchJson<T>(path: string): Promise<T | null> {
  if (!serverFetch) return null;
  try {
    const res = await serverFetch(path);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---- Formatting ----

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatUsd(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

function blockTotalTokens(b: UsageBlock): number {
  return b.total.input + b.total.output + b.total.cacheRead + b.total.cacheCreation;
}

function formatTimeRange(b: UsageBlock): string {
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  return `${new Date(b.start).toLocaleTimeString([], opts)}-${new Date(b.end).toLocaleTimeString([], opts)}`;
}

// Tokens/min over the block's own active span (first to last write), not
// over the whole window, which would read as near-zero for a block that is
// mostly idle time.
function burnRate(b: UsageBlock): number | null {
  const spanMin = (b.lastAt - b.firstAt) / 60_000;
  if (spanMin < 0.5) return null;
  return blockTotalTokens(b) / spanMin;
}

// "4h 38m", "2d 21h" - the coarsest two units that still say something.
function formatRemaining(untilMs: number): string {
  const total = Math.max(0, untilMs - Date.now());
  const minutes = Math.floor(total / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

// When the window actually resets: "11:40 PM" today, "Sat 2:00 PM" this
// week, "18 Sep, 2:00 PM" beyond it. A countdown answers "how long do I
// wait"; this answers "can I pick it up after lunch", which is the question
// a weekly or 30-day window raises.
function formatResetAt(atMs: number): string {
  const at = new Date(atMs);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const now = new Date();
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  if (sameDay) return time;
  const withinWeek = atMs - now.getTime() < 6 * 24 * 60 * 60 * 1000;
  if (withinWeek) return `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${at.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

// ---- Shared polling ----

// One timer for every item and the view: three status-bar items polling the
// same route separately would triple the work for one payload.
let usageState: UsageResponse | null = null;
const usageListeners = new Set<(value: UsageResponse | null) => void>();
let usageTimer: ReturnType<typeof setInterval> | null = null;

async function refreshUsage(): Promise<void> {
  const data = await fetchJson<UsageResponse>("/usage");
  if (!data) return;
  usageState = data;
  for (const listener of usageListeners) listener(data);
}

function useUsage(): UsageResponse | null {
  const [value, setValue] = useState<UsageResponse | null>(usageState);
  useEffect(() => {
    usageListeners.add(setValue);
    if (usageTimer === null) {
      usageTimer = setInterval(() => void refreshUsage(), USAGE_POLL_MS);
    }
    void refreshUsage();
    return () => {
      usageListeners.delete(setValue);
      if (usageListeners.size === 0 && usageTimer !== null) {
        clearInterval(usageTimer);
        usageTimer = null;
      }
    };
  }, []);
  return value;
}

// A boolean setting, re-read when Settings changes it.
function useFlag(key: string, fallback = true): boolean {
  const read = useCallback(() => {
    const value = settingsApi?.get(key);
    return typeof value === "boolean" ? value : fallback;
  }, [key, fallback]);
  const [value, setValue] = useState(read);
  useEffect(() => {
    setValue(read());
    return settingsApi?.onDidChange(() => setValue(read()));
  }, [read]);
  return value;
}

// ---- The view behind every item ----

function LimitRow({ limit }: { limit: LimitWindow }) {
  const pct = Math.round(limit.usedPercent);
  return (
    <div className="usage-limit-row">
      <span className="usage-limit-label">{limit.label}</span>
      <Meter pct={pct} />
      <span className="usage-limit-value">
        {pct}%
        {limit.resetsAt ? (
          <>
            {" · "}
            {formatRemaining(limit.resetsAt)} left
            <span className="usage-limit-at"> · {formatResetAt(limit.resetsAt)}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}

// The agent's own mark: its image, else its codicon, else nothing — the
// label is in the tooltip either way, so an agent with no icon costs the
// reader nothing.
//
// The image is drawn as a mask rather than an <img>, for two reasons: these
// marks are authored for a UI that sets their colour (Codex's is
// fill="currentColor", which an <img> resolves to black and loses on a dark
// bar), and a mask can't execute anything, unlike an SVG inlined as markup
// from whichever extension contributed the agent.
function AgentMark({ agent }: { agent: AgentUsage }) {
  if (agent.iconUrl) {
    const mask = `url("${agent.iconUrl.replace(/"/g, '\\"')}")`;
    return (
      <span
        className="usage-agent-mark masked"
        aria-hidden="true"
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      />
    );
  }
  if (agent.icon) return <span className={`codicon codicon-${agent.icon} usage-agent-mark`} aria-hidden="true" />;
  return null;
}

function Meter({ pct }: { pct: number }) {
  return (
    <span className="usage-meter">
      <span
        className={`usage-meter-fill${pct >= 90 ? " critical" : pct >= 70 ? " warn" : ""}`}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </span>
  );
}

function SpendLine({ agent }: { agent: AgentUsage }) {
  if (!agent.spend.supported) {
    return <div className="usage-spend muted">Cost not reported by {agent.label}.</div>;
  }
  return (
    <div className="usage-spend">
      <span>
        today <b>{formatUsd(agent.spend.today ?? 0)}</b>
      </span>
      <span>
        7 days <b>{formatUsd(agent.spend.last7Days ?? 0)}</b>
      </span>
      {agent.spend.partial && <span className="muted">at least</span>}
    </div>
  );
}

function AgentSection({ agent }: { agent: AgentUsage }) {
  const current = agent.blocks.find((b) => b.isCurrent);
  const previous = agent.blocks.filter((b) => !b.isCurrent);
  const rate = current ? burnRate(current) : null;
  return (
    <section className="usage-agent">
      <header className="usage-agent-head">
        <AgentMark agent={agent} />
        <span className="usage-agent-name">{agent.label}</span>
        {agent.plan && <span className="usage-agent-plan">{agent.plan}</span>}
      </header>
      {agent.limits.map((limit) => (
        <LimitRow key={limit.label} limit={limit} />
      ))}
      <SpendLine agent={agent} />
      {current ? (
        <div className="usage-current">
          <div className="usage-headline">{formatCount(blockTotalTokens(current))} tokens</div>
          <div className="usage-subline">
            Current block · {formatTimeRange(current)}
            {rate !== null ? ` · ${formatCount(rate)} tok/min` : ""}
          </div>
          <ul className="usage-models">
            {Object.entries(current.perModel).map(([model, t]) => (
              <li key={model}>
                {modelLabel(model)}: {formatCount(t.input + t.output + t.cacheRead + t.cacheCreation)}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="usage-empty">No activity in the current block.</div>
      )}
      {previous.length > 0 && (
        <div className="usage-previous">
          {previous.map((b) => (
            <div key={b.start} className="usage-previous-row">
              <span>{formatTimeRange(b)}</span>
              <span>{formatCount(blockTotalTokens(b))}</span>
            </div>
          ))}
        </div>
      )}
      {agent.notes.map((note) => (
        <div key={note} className="usage-note">
          {note}
        </div>
      ))}
    </section>
  );
}

// The readout behind one status-bar item. `agentId` names the agent that
// item stands for, and that agent is all it shows: each item owns its own
// popover, so clicking Claude never makes you scroll past Codex. Without an
// id (nothing in the bar to anchor it) it falls back to every agent.
function UsageView({ agentId }: { agentId?: string }) {
  const usage = useUsage();
  const agents = useMemo(() => {
    const list = usage?.agents ?? [];
    if (!agentId) return list;
    const one = list.find((a) => a.id === agentId);
    return one ? [one] : [];
  }, [usage, agentId]);

  if (!usage) return <div className="usage-empty">Loading…</div>;
  if (agents.length === 0) return <div className="usage-empty">No usage recorded yet.</div>;

  return (
    <div className="usage-view">
      {agents.map((agent) => (
        <AgentSection key={agent.id} agent={agent} />
      ))}
      <div className="usage-footnote">
        Token blocks are counted from the agent's own local files; limits and cost are its own figures.
      </div>
    </div>
  );
}

// ---- Status-bar items ----

interface StatusItemContext {
  openPopover(anchor: DOMRect, content: ReturnType<typeof UsageView>): void;
  closePopover(): void;
}

// One agent's limits in the bar. Hidden while that agent reports no limits
// (nothing to show) or its Settings checkbox is off.
function AgentItem({ agentId, settingKey, context }: { agentId: string; settingKey: string; context: StatusItemContext }) {
  const usage = useUsage();
  const enabled = useFlag(settingKey);
  const agent = usage?.agents.find((a) => a.id === agentId);
  if (!enabled || !agent || agent.limits.length === 0) return null;

  const title = agent.limits
    .map(
      (l) =>
        `${l.label}: ${Math.round(l.usedPercent)}% used${
          l.resetsAt ? `, resets ${formatResetAt(l.resetsAt)} (in ${formatRemaining(l.resetsAt)})` : ""
        }`,
    )
    .join("\n");

  return (
    <button
      className="status-bar-item usage-status-item"
      data-menu-trigger="true"
      aria-haspopup="dialog"
      title={`${agent.label}\n${title}`}
      onClick={(e) =>
        context.openPopover(e.currentTarget.getBoundingClientRect(), <UsageView agentId={agentId} />)
      }
    >
      {agent.iconUrl || agent.icon ? (
        <AgentMark agent={agent} />
      ) : (
        <span className="usage-status-name">{shortLabel(agent.label)}</span>
      )}
      {/* Each window carries its own countdown: knowing the 5-hour limit is
          back in an hour says nothing about the weekly one, so a single
          number for both would answer the wrong question. A model's slice of
          the week resets with the week, so it carries the model's name there
          instead - "32% Fable" says which cap that percentage is against.
          Only the first window draws a meter - the one you spend against
          hour to hour - so a second bar doesn't double the item's width for
          a number that barely moves. The countdowns are `full-only`, which
          the host drops from the compact bar a phone gets. */}
      {agent.limits.map((limit, index) => (
        <span className="usage-status-meter" key={limit.label}>
          {index > 0 && <span className="usage-status-sep">·</span>}
          {index === 0 && <Meter pct={Math.round(limit.usedPercent)} />}
          <span className="usage-status-text">{Math.round(limit.usedPercent)}%</span>
          {limit.scoped ? (
            <span className="usage-status-scope">{limit.scope}</span>
          ) : (
            limit.resetsAt !== null && (
              <span className="usage-status-reset full-only">{formatRemaining(limit.resetsAt)}</span>
            )
          )}
        </span>
      ))}
    </button>
  );
}

// "Claude Code" -> "Claude": what an agent with no mark of its own falls
// back to, since the bar has room for a name but not a product title.
function shortLabel(label: string): string {
  return label.split(" ")[0];
}

// What the terminal you are looking at is running. Nothing renders for a
// plain shell, so the bar stays quiet outside agent windows.
function ModelItem({ context }: { context: StatusItemContext }) {
  const enabled = useFlag("agentUsage.showModel");
  const [ctx, setCtx] = useState<ActiveContext>(() => appApi?.getActiveContext() ?? { sessionName: null, windowIndex: null, cwd: null });
  const [info, setInfo] = useState<ModelResponse | null>(null);

  useEffect(() => appApi?.onDidChangeContext(setCtx), []);

  useEffect(() => {
    if (!enabled || !ctx.sessionName || ctx.windowIndex === null) {
      setInfo(null);
      return;
    }
    let cancelled = false;
    // The folder isn't sent: core resolves the window itself, and its answer
    // carries the agent's cwd.
    const query = `/model?session=${encodeURIComponent(ctx.sessionName)}&window=${ctx.windowIndex}`;
    const poll = async () => {
      const data = await fetchJson<ModelResponse>(query);
      if (!cancelled) setInfo(data?.model ? data : null);
    };
    void poll();
    const timer = setInterval(poll, MODEL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, ctx.sessionName, ctx.windowIndex, ctx.cwd]);

  if (!enabled || !info?.model) return null;

  return (
    <button
      className="status-bar-item usage-model-item"
      data-menu-trigger="true"
      aria-haspopup="dialog"
      title={`${info.label ?? "Agent"} · ${info.model}${ctx.cwd ? `\n${ctx.cwd}` : ""}`}
      onClick={(e) =>
        context.openPopover(e.currentTarget.getBoundingClientRect(), <UsageView agentId={info.agentId} />)
      }
    >
      {modelLabel(info.model)}
    </button>
  );
}

// ---- Activation ----

interface ExtensionContext {
  registerStatusBarItem(item: {
    id: string;
    title?: string;
    placement?: "left" | "right";
    order?: number;
    // Hands this item's own show setting to the host, so the gear menu's
    // Status Bar list drives it instead of offering a second switch beside
    // it. Ignored by hosts that predate the list, which is why each item
    // below still checks the same setting itself.
    visibilitySetting?: string;
    component: (props: { context: StatusItemContext }) => ReturnType<typeof ModelItem>;
  }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  settings: SettingsApi;
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
  };
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  settingsApi = ctx.settings;
  appApi = ctx.app;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerStatusBarItem({
    id: "usage-claude",
    title: "Claude usage",
    placement: "left",
    order: 10,
    visibilitySetting: "agentUsage.showClaude",
    component: ({ context }) => <AgentItem agentId="claude" settingKey="agentUsage.showClaude" context={context} />,
  });
  ctx.registerStatusBarItem({
    id: "usage-codex",
    title: "Codex usage",
    placement: "left",
    order: 11,
    visibilitySetting: "agentUsage.showCodex",
    component: ({ context }) => <AgentItem agentId="codex" settingKey="agentUsage.showCodex" context={context} />,
  });
  ctx.registerStatusBarItem({
    id: "model",
    title: "Model",
    placement: "left",
    order: 12,
    visibilitySetting: "agentUsage.showModel",
    component: ModelItem,
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  if (usageTimer !== null) {
    clearInterval(usageTimer);
    usageTimer = null;
  }
  usageListeners.clear();
  usageState = null;
  serverFetch = null;
  settingsApi = null;
  appApi = null;
}
