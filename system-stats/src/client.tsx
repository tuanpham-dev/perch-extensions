// system-stats client: host memory as a status bar item, and the popover it
// opens with CPU (as a 2-minute chart), memory, swap, disks and network.
// Polling lives in statsStore.ts, the row model in systemStats.ts, and the
// readings themselves in server.js.
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import {
  CPU_HISTORY_SAMPLES,
  appendCpuSample,
  formatGb,
  levelOf,
  systemStatRows,
  systemStatsSummary,
} from "./systemStats";
import {
  resetStatsStore,
  resetTerminalStats,
  setServerFetch,
  useDetailedSystemStats,
  useSystemStats,
  useTerminalStats,
  type TerminalRow,
} from "./statsStore";

let removeStylesheet: (() => void) | null = null;

// The host's codicon font is global CSS, so its classes work here even
// though core's Icon component doesn't.
function Codicon({ name }: { name: string }) {
  return <span className={`codicon codicon-${name}`} aria-hidden="true" />;
}

// ---- CPU chart ----

const CHART_WIDTH = 240;
// Readings closer together than this share one chart slot. Opening the
// popover fires a detailed poll right behind the item's own, and the server
// answers both from the same CPU window, so without it the first seconds
// would crowd several points into the space of one 3s step.
const MIN_SAMPLE_GAP_MS = 2000;
const CHART_HEIGHT = 48;

// Newest reading at the right edge, each earlier one a fixed step to its
// left, so the line grows in from the right while the window fills and then
// scrolls. A fixed 0-100 scale keeps an idle box looking idle instead of
// stretching noise to fill the height.
function CpuChart({ samples }: { samples: readonly number[] }) {
  const step = CHART_WIDTH / (CPU_HISTORY_SAMPLES - 1);
  const x = (i: number) => CHART_WIDTH - (samples.length - 1 - i) * step;
  const y = (percent: number) => CHART_HEIGHT - (percent / 100) * CHART_HEIGHT;
  const points = samples.map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`);
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  return (
    <svg
      className="sysstats-cpu-chart"
      data-level={levelOf(latest)}
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {[25, 50, 75].map((p) => (
        <line key={p} className="sysstats-cpu-grid" x1="0" x2={CHART_WIDTH} y1={y(p)} y2={y(p)} />
      ))}
      {points.length > 1 && (
        <path
          className="sysstats-cpu-area"
          d={`M${x(0).toFixed(1)},${CHART_HEIGHT}L${points.join("L")}L${CHART_WIDTH},${CHART_HEIGHT}Z`}
        />
      )}
      {points.length > 1 && <polyline className="sysstats-cpu-line" points={points.join(" ")} />}
      {/* A lone first reading has no segment to draw yet; a short tick at
          the right edge shows where the line will start. */}
      {points.length === 1 && latest !== null && (
        <line
          className="sysstats-cpu-line"
          x1={CHART_WIDTH - step}
          x2={CHART_WIDTH}
          y1={y(latest)}
          y2={y(latest)}
        />
      )}
    </svg>
  );
}

// ---- Popover ----

// Reads the store rather than a snapshot prop, so the rows keep moving while
// it's open even though the host captured this node at click time, and
// subscribing through useDetailedSystemStats is what asks the server for the
// expensive half of the reading, for exactly as long as this is mounted.
//
// The CPU history is this component's own state: the host unmounts popover
// content on close, so every opening starts a new chart.
// Opens a terminal window as a tab (or focuses it); set from activate().
let openSessionWindow: ((sessionName: string, opts?: { windowIndex?: number }) => void) | null = null;

const TERMINAL_ROWS = 8;

function formatMemory(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

// CPU and memory per terminal window, busiest first. Mounted only inside the
// popover, so the process walk behind it runs only while the popover is open.
function TerminalsTable({ onOpen }: { onOpen: () => void }) {
  const stats = useTerminalStats();
  const [showAll, setShowAll] = useState(false);
  if (!stats) return <div className="sysstats-terminals-note">Reading terminals…</div>;
  if (!stats.supported) {
    return <div className="sysstats-terminals-note">Per-terminal figures aren't available on this system.</div>;
  }
  if (stats.rows.length === 0) return <div className="sysstats-terminals-note">No terminals are open.</div>;
  const rows = showAll ? stats.rows : stats.rows.slice(0, TERMINAL_ROWS);
  const open = (row: TerminalRow) => {
    openSessionWindow?.(row.sessionName, { windowIndex: row.windowIndex });
    onOpen();
  };
  return (
    <div className="sysstats-terminals">
      <div className="sysstats-terminals-head">
        <span>Terminals</span>
        <span className="sysstats-terminals-num">CPU</span>
        <span className="sysstats-terminals-num">Mem</span>
      </div>
      {rows.map((row) => (
        <button
          key={`${row.sessionName}:${row.windowIndex}`}
          className="sysstats-terminals-row"
          title={`Open ${row.project} · ${row.windowName}`}
          onClick={() => open(row)}
        >
          <span className="sysstats-terminals-name">
            {row.project} · {row.windowName}
          </span>
          <span className="sysstats-terminals-num">
            {row.cpuPercent === null ? "-" : `${Math.round(row.cpuPercent)}%`}
          </span>
          <span className="sysstats-terminals-num">{formatMemory(row.rssBytes)}</span>
        </button>
      ))}
      {stats.rows.length > TERMINAL_ROWS && (
        <button className="sysstats-terminals-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all (${stats.rows.length})`}
        </button>
      )}
    </div>
  );
}

function StatsPopover({ onClose }: { onClose: () => void }) {
  const stats = useDetailedSystemStats();
  const [cpuHistory, setCpuHistory] = useState<readonly number[]>([]);
  const lastSampleAt = useRef(0);

  // Once per new reading (the snapshot's reference only changes when a poll
  // succeeds), starting with the one already on hand when the popover opens.
  useEffect(() => {
    if (!stats || stats.cpuPercent === null) return;
    const now = Date.now();
    if (now - lastSampleAt.current < MIN_SAMPLE_GAP_MS) return;
    lastSampleAt.current = now;
    setCpuHistory((history) => appendCpuSample(history, stats.cpuPercent));
  }, [stats]);

  if (!stats) {
    return <div className="sysstats-empty">Host statistics unavailable</div>;
  }
  // The first opening in a session, for the moment between mounting and the
  // detailed reading it just asked for.
  if (!stats.detail) {
    return <div className="sysstats-empty">Reading host statistics…</div>;
  }

  return (
    <div className="sysstats">
      {systemStatRows(stats, stats.detail).map((row) => {
        let graphic: ReactNode = null;
        if (row.id === "cpu") {
          graphic = <CpuChart samples={cpuHistory} />;
        } else if (row.meter) {
          // Decoration over the percentage right above it, so it stays out
          // of the accessibility tree rather than repeating the number.
          graphic = (
            <div className="sysstats-meter" aria-hidden="true">
              <span
                className="sysstats-meter-fill"
                data-level={levelOf(row.meter.percent)}
                style={{ width: `${row.meter.percent ?? 0}%` }}
              />
            </div>
          );
        }
        return (
          <div key={row.id} className="sysstats-row">
            <div className="sysstats-head">
              <Codicon name={row.icon} />
              <span className="sysstats-label">{row.label}</span>
              <span className="sysstats-percent">{row.value}</span>
            </div>
            {graphic}
            <div className="sysstats-detail">{row.detail}</div>
            {row.note && <div className="sysstats-note">{row.note}</div>}
          </div>
        );
      })}
      <TerminalsTable onOpen={onClose} />
      <div className="sysstats-summary">{systemStatsSummary(stats.detail)}</div>
    </div>
  );
}

// ---- Status bar item ----

interface StatusItemContext {
  openPopover(anchor: DOMRect, content: ReactNode): void;
  closePopover?(): void;
}

function MemoryItem({ context }: { context: StatusItemContext }) {
  const stats = useSystemStats();
  return (
    <button
      className="status-bar-item"
      data-menu-trigger="true"
      aria-haspopup="dialog"
      title={
        stats
          ? `${formatGb(stats.memUsedBytes)} GB of ${formatGb(stats.memTotalBytes)} GB memory in use - click for CPU, memory and disk`
          : "Host statistics unavailable"
      }
      // openPopover toggles: the host keys it on this item's id.
      onClick={(e) => context.openPopover(e.currentTarget.getBoundingClientRect(), <StatsPopover onClose={() => context.closePopover?.()} />)}
    >
      <Codicon name="chip" />
      <span>
        {stats ? formatGb(stats.memUsedBytes) : "-"}
        {/* The host hides .full-only on a compact (phone) bar. */}
        <span className="full-only">{stats ? ` / ${formatGb(stats.memTotalBytes)} GB` : " GB"}</span>
      </span>
    </button>
  );
}

// ---- Activation ----

interface ExtensionContext {
  registerStatusBarItem(item: {
    id: string;
    // Names this readout in the gear menu's Status Bar show/hide list.
    title?: string;
    placement?: "left" | "right";
    order?: number;
    component: (props: { context: StatusItemContext }) => ReturnType<typeof MemoryItem>;
  }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  app?: { openSessionWindow?(sessionName: string, opts?: { windowIndex?: number }): void };
}

export function activate(ctx: ExtensionContext): void {
  setServerFetch(ctx.serverFetch);
  openSessionWindow = ctx.app?.openSessionWindow ?? null;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerStatusBarItem({ id: "memory", title: "Memory", placement: "right", component: MemoryItem });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  resetStatsStore();
  resetTerminalStats();
  openSessionWindow = null;
}
