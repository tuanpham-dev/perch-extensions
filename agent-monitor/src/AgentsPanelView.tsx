// The AGENTS view in the host's bottom panel (Perch's registerPanelView):
// every agent window as one row of a status table, the recent hook events
// under it, and a notice for each agent whose hooks are not installed. The
// same rows the board and the PROJECTS marks come from - one classification,
// three places to read it - plus the event ring server.js keeps for the feed.
//
// Mounted only while its tab is the one showing, so the polling below starts
// and stops with the component; the board's own poll is untouched.
import { useCallback, useEffect, useState } from "react";
import Icon from "./Icon";
import { labelOf, markOf, type BoardAgent, type Mark } from "./boardModel";
import {
  fetchHookStates,
  getJson,
  host,
  installHooks,
  type HookStateRow,
  type MenuItem,
} from "./host";

interface HookEventRow {
  at: number;
  event: string;
  agent: string;
  paneId: string;
  sessionName: string | null;
}

interface PanelViewContext {
  mobilePointer: boolean;
  showMenu(x: number, y: number, items: MenuItem[]): void;
  confirmDialog(message: string, confirmLabel?: string): Promise<boolean>;
}

// Faster than the board's own setting: the view is mounted only while it is
// on screen, and a row has to leave within a few seconds of its agent
// exiting (the server itself answers within a fraction of a second).
const ROWS_POLL_MS = 2_000;
const EVENTS_POLL_MS = 5_000;
// Hook notices the user dismissed, by agent id - per browser, like the
// board's own remembered scope.
const DISMISSED_KEY = "agentMonitor.panel.dismissedHookNotices";

function readDismissed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage unavailable: the notice comes back next time, which is the
    // safe side.
  }
}

// Waiting first - the rows asking for the user - then the most recently
// active.
const MARK_RANK: Record<Mark, number> = { waiting: 0, working: 1, interrupted: 2, done: 3, idle: 4 };

function sortRows(rows: BoardAgent[]): BoardAgent[] {
  return [...rows].sort((a, b) => {
    const rank = MARK_RANK[markOf(a)] - MARK_RANK[markOf(b)];
    if (rank !== 0) return rank;
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  });
}

const STATE_TITLE: Record<Mark, string> = {
  working: "Working",
  waiting: "Waiting",
  done: "Done",
  interrupted: "Interrupted",
  idle: "Idle",
};

function ago(at: number | null, now: number): string {
  if (at === null) return "-";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function clock(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function AgentMark({ row }: { row: BoardAgent }) {
  const mark = markOf(row);
  // The same 8px marks the PROJECTS rows wear (style.css), so a state reads
  // the same in both places.
  return (
    <span className={`agent-panel-state agent-panel-state-${mark}`}>
      <span className={`agent-monitor-badge-${mark}`} aria-hidden="true">
        {mark === "waiting" ? "?" : "●"}
      </span>
      {STATE_TITLE[mark]}
    </span>
  );
}

function AgentIcon({ row }: { row: Pick<BoardAgent, "iconUrl" | "icon" | "agentLabel"> }) {
  if (row.iconUrl) return <img className="agent-panel-icon" src={row.iconUrl} alt="" />;
  return <Icon name={row.icon || "robot"} className="agent-panel-icon" />;
}

export default function AgentsPanelView({ context }: { context: PanelViewContext }) {
  // null until the first answer, so the empty state is the server's word
  // rather than a flash on mount before it has been asked.
  const [rows, setRows] = useState<BoardAgent[] | null>(null);
  const [events, setEvents] = useState<HookEventRow[]>([]);
  const [hookStates, setHookStates] = useState<HookStateRow[]>([]);
  const [installing, setInstalling] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refreshRows = useCallback(async () => {
    try {
      const body = await getJson<{ agents: BoardAgent[] }>("/agents");
      setRows(body.agents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshEvents = useCallback(async () => {
    try {
      const body = await getJson<{ events: HookEventRow[] }>("/events");
      setEvents(body.events);
    } catch {
      // The rows poll reports the error; the feed keeps what it has.
    }
  }, []);

  const refreshHooks = useCallback(async () => {
    try {
      setHookStates(await fetchHookStates());
    } catch {
      // Without an answer there is no notice to show, which is the safe side.
    }
  }, []);

  useEffect(() => {
    void refreshRows();
    void refreshEvents();
    void refreshHooks();
    const rowsTimer = window.setInterval(() => {
      if (!document.hidden) void refreshRows();
    }, ROWS_POLL_MS);
    const eventsTimer = window.setInterval(() => {
      if (!document.hidden) void refreshEvents();
    }, EVENTS_POLL_MS);
    // The "since" column ticks on its own, between polls.
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(rowsTimer);
      window.clearInterval(eventsTimer);
      window.clearInterval(clockTimer);
    };
  }, [refreshRows, refreshEvents, refreshHooks]);

  const openRow = (row: Pick<BoardAgent, "sessionName" | "windowIndex">) => {
    host.app?.openSessionWindow(row.sessionName, { windowIndex: row.windowIndex });
  };

  const onInstall = (agentId: string) => {
    setInstalling(agentId);
    installHooks(agentId)
      .then(() => refreshHooks())
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setInstalling(null));
  };

  // Agents worth a notice: enabled, present on the machine, hook-capable,
  // and without hooks. An agent with no hook format at all ("unsupported")
  // has nothing to install.
  const missingHooks = hookStates.filter(
    (h) => h.enabled && h.installed && h.state === "not-installed" && !dismissed.has(h.agentId),
  );
  const onDismiss = (agentId: string) => {
    const next = new Set(dismissed);
    next.add(agentId);
    setDismissed(next);
    writeDismissed(next);
  };
  const byPane = new Map((rows ?? []).map((r) => [r.paneId, r]));
  const sorted = sortRows(rows ?? []);

  return (
    <div className="agent-panel">
      {error && (
        <div className="agent-panel-error">
          <span>Couldn't load Agents: {error}</span>
          <button className="agent-panel-button" onClick={() => void refreshRows()}>
            Retry
          </button>
        </div>
      )}
      {missingHooks.map((h) => (
        <div key={h.agentId} className="agent-panel-notice">
          <span>
            {h.label} has no hooks installed, so its states come from pane titles and transcripts only.
          </span>
          <button
            className="agent-panel-button"
            disabled={installing === h.agentId}
            onClick={() => onInstall(h.agentId)}
          >
            {installing === h.agentId ? "Installing…" : "Install hooks"}
          </button>
          <button
            className="agent-panel-dismiss"
            title="Don't show this again in this browser"
            aria-label="Dismiss"
            onClick={() => onDismiss(h.agentId)}
          >
            <Icon name="close" />
          </button>
        </div>
      ))}
      {rows === null && !error ? null : sorted.length === 0 && !error ? (
        <div className="agent-panel-empty">No agent is running in your terminals.</div>
      ) : (
        <table className="agent-panel-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Project / Window</th>
              <th>State</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const mark = markOf(row);
              const detail = labelOf(row, mark);
              return (
                <tr
                  key={row.paneId || `${row.sessionName}:${row.windowIndex}`}
                  className="agent-panel-row"
                  title={row.prompt ? `${detail}\n${row.prompt}` : detail}
                  onClick={() => openRow(row)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    context.showMenu(e.clientX, e.clientY, [
                      { label: "Open Window", onClick: () => openRow(row) },
                    ]);
                  }}
                >
                  <td>
                    <span className="agent-panel-agent">
                      <AgentIcon row={row} />
                      {row.agentLabel}
                    </span>
                  </td>
                  <td className="agent-panel-window">
                    <span className="agent-panel-project">{row.project}</span>
                    <span className="agent-panel-sep">/</span>
                    {row.windowName}
                  </td>
                  <td>
                    <AgentMark row={row} />
                  </td>
                  <td className="agent-panel-since">{ago(row.lastActivityAt, now)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="agent-panel-feed">
        <div className="agent-panel-feed-title">Recent events</div>
        {events.length === 0 && (
          <div className="agent-panel-feed-empty">
            No hook events yet. Events arrive from agents whose hooks are installed.
          </div>
        )}
        {events.map((ev, i) => {
          const row = ev.paneId ? byPane.get(ev.paneId) : undefined;
          const where = row
            ? `${row.project} / ${row.windowName}`
            : ev.sessionName
              ? ev.sessionName
              : "";
          const agent = hookStates.find((h) => h.agentId === ev.agent)?.label ?? row?.agentLabel ?? ev.agent;
          return (
            <div
              key={`${ev.at}-${ev.paneId}-${i}`}
              className={`agent-panel-event${row ? " clickable" : ""}`}
              onClick={row ? () => openRow(row) : undefined}
              role={row ? "button" : undefined}
            >
              <span className="agent-panel-event-time">{clock(ev.at)}</span>
              <span className="agent-panel-event-agent">{agent}</span>
              <span className="agent-panel-event-where">{where}</span>
              <span className="agent-panel-event-name">{ev.event}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
