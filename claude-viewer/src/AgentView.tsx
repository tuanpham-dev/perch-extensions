// Subagents: reading one subagent's conversation in place of the main one,
// the chip and list that find every subagent in the session, and the line
// where a background agent's finish arrived. Everything here reads the agent
// records chatModel.ts keeps on Agent (and Task) cards.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { agentStats, agentStatus, listAgents, type AgentStatus, type ChatModel, type ToolCard } from "./chatModel";
import { modelLabel } from "./usage";

// ---- Navigation ----

// Which subagent is open: tool ids from the main conversation down, [] for
// the main conversation itself.
export type AgentNav = { path: string[]; open(toolId: string): void };

export const AgentNavContext = createContext<AgentNav>({ path: [], open() {} });

export const useAgentNav = () => useContext(AgentNavContext);

// The ids from the top-level agent down to this card, following parents.
export function pathTo(model: ChatModel, toolId: string): string[] {
  const path: string[] = [];
  for (let id: string | null = toolId; id && model.tools[id]; id = model.tools[id].parent) path.unshift(id);
  return path;
}

// The longest start of `path` whose cards all still exist, one inside the
// next. After /clear the model is new and the path empties.
export function livePath(model: ChatModel, path: string[]): string[] {
  const out: string[] = [];
  for (const id of path) {
    const card = model.tools[id];
    if (!card?.agent || card.parent !== (out.at(-1) ?? null)) break;
    out.push(id);
  }
  return out;
}

// ---- Formatting ----

// Ticks while `on`, for elapsed times that count up.
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [on]);
  return now;
}

export function formatElapsed(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatTokens(n: number | null): string {
  if (n === null) return "";
  if (n < 1000) return `${n} tokens`;
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k tokens`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k tokens`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M tokens`;
}

const STATUS_LABEL: Record<AgentStatus, string> = { running: "running", done: "done", failed: "failed", stopped: "stopped" };

const ENDED: Record<AgentStatus, string> = { running: "is running again", done: "finished", failed: "failed", stopped: "was stopped" };

function agentName(card: ToolCard): string {
  return card.agent?.type ?? card.name;
}

// "haiku-4-5 · 1m 12s · 14 steps · 38.2k tokens", leaving out what isn't known.
function factsLine(card: ToolCard, now: number): string {
  const stats = agentStats(card, now);
  return [
    modelLabel(stats.model),
    formatElapsed(stats.elapsedMs),
    `${stats.steps} ${stats.steps === 1 ? "step" : "steps"}`,
    formatTokens(stats.tokens),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function StatusPill({ status }: { status: AgentStatus }) {
  return <span className={`cv-agent-pill cv-agent-pill-${status}`}>{STATUS_LABEL[status]}</span>;
}

// ---- The open subagent's header ----

export function AgentHeader({
  model,
  path,
  version,
  onNavigate,
}: {
  model: ChatModel;
  path: string[];
  // Bumped when the (mutable) model changes.
  version: number;
  onNavigate: (path: string[]) => void;
}) {
  const card = model.tools[path.at(-1) ?? ""];
  const status = card ? agentStatus(card) : "done";
  const now = useNow(status === "running");
  if (!card) return null;
  return (
    <div className="cv-agent-head" data-version={version}>
      <nav className="cv-agent-crumbs" aria-label="Subagent path">
        <button type="button" className="btn cv-agent-back" onClick={() => onNavigate(path.slice(0, -1))}>
          ← Back
        </button>
        <button type="button" className="cv-agent-crumb" onClick={() => onNavigate([])}>
          Main
        </button>
        {path.map((id, i) => {
          const part = model.tools[id];
          const last = i === path.length - 1;
          return (
            <span key={id} className="cv-agent-crumb-part">
              <span aria-hidden="true">›</span>
              {last ? (
                <span aria-current="page">{part ? agentName(part) : "Agent"}</span>
              ) : (
                <button type="button" className="cv-agent-crumb" onClick={() => onNavigate(path.slice(0, i + 1))}>
                  {part ? agentName(part) : "Agent"}
                </button>
              )}
            </span>
          );
        })}
      </nav>
      <div className="cv-agent-title">
        <strong>{agentName(card)}</strong>
        {card.agent?.description && <span>{card.agent.description}</span>}
        <StatusPill status={status} />
      </div>
      <div className="cv-agent-facts">{factsLine(card, now)}</div>
    </div>
  );
}

// ---- Where a background agent's finish arrived ----

export function AgentNote({ card }: { card: ToolCard }) {
  const nav = useAgentNav();
  const status = agentStatus(card);
  const label = `Agent "${card.agent?.description ?? agentName(card)}" ${ENDED[status]}`;
  return (
    <button type="button" className={`cv-agent-note cv-agent-note-${status}`} onClick={() => nav.open(card.id)} title="Open its transcript">
      <span className="cv-agent-note-dot" aria-hidden="true">●</span>
      <span>{label}</span>
    </button>
  );
}

// ---- Every subagent in the session ----

export function AgentsChip({
  model,
  version,
  onOpen,
}: {
  model: ChatModel;
  version: number;
  onOpen: (path: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const agents = listAgents(model);
  const running = agents.filter((a) => agentStatus(model.tools[a.toolId]) === "running").length;
  const now = useNow(open && running > 0);

  // Closes on a click anywhere else, and on Esc (ChatTab hands that over by
  // the event below, so Esc never also stops Claude while the list is open).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onClose = () => setOpen(false);
    document.addEventListener("pointerdown", onDown);
    rootRef.current?.addEventListener("cv-close-agents", onClose);
    const root = rootRef.current;
    return () => {
      document.removeEventListener("pointerdown", onDown);
      root?.removeEventListener("cv-close-agents", onClose);
    };
  }, [open]);

  if (agents.length === 0) return null;
  const label = `${agents.length} ${agents.length === 1 ? "agent" : "agents"}${running > 0 ? ` · ${running} running` : ""}`;
  return (
    <div className="cv-agents" ref={rootRef} data-open={open || undefined} data-version={version}>
      <button
        type="button"
        className={`cv-foot-btn cv-agents-chip${running > 0 ? " cv-agents-chip-running" : ""}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen(!open)}
        title="Subagents in this conversation"
      >
        {label}
      </button>
      {open && (
        <div className="cv-agents-list" role="listbox" aria-label="Subagents">
          {agents.map(({ toolId, depth }) => {
            const card = model.tools[toolId];
            const status = agentStatus(card);
            return (
              <button
                key={toolId}
                type="button"
                role="option"
                aria-selected={false}
                className="cv-agents-row"
                style={{ paddingLeft: `${10 + depth * 18}px` }}
                onClick={() => {
                  setOpen(false);
                  onOpen(pathTo(model, toolId));
                }}
              >
                <span className="cv-agents-row-top">
                  <strong>{agentName(card)}</strong>
                  <StatusPill status={status} />
                </span>
                {card.agent?.description && <span className="cv-agents-row-desc">{card.agent.description}</span>}
                <span className="cv-agent-facts">{factsLine(card, now)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Whether an Esc should go to an open agents list: closes it and says so.
export function closeAgentsList(root: HTMLElement | null): boolean {
  const list = root?.querySelector(".cv-agents[data-open]");
  if (!list) return false;
  list.dispatchEvent(new Event("cv-close-agents"));
  return true;
}
