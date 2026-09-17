// The bar above the conversation: permission mode (click to cycle), what
// Claude is doing, context and estimated cost (unless turned off), and the
// optional plan usage meters. The model sits with the mode and status.
import { useEffect, useState } from "react";
import { getJson, setting } from "./bridge";
import type { ScreenState } from "./types";
import { contextWindowFor, currentModelLabel, formatTokens, type UsageTally } from "./usage";

type UsageWindow = { utilization: number; resetsAt: string | null };
type PlanUsage = { available: boolean; fiveHour: UsageWindow | null; sevenDay: UsageWindow | null };

const MODE_HINT: Record<string, string> = {
  auto: "Auto mode: Claude decides which actions need your approval",
  manual: "Manual mode: Claude asks before acting",
  acceptEdits: "Accept edits: file edits don't ask",
  plan: "Plan mode: Claude plans without changing files",
  bypassPermissions: "Bypass permissions: nothing asks",
};

function resetLabel(resetsAt: string | null): string {
  if (!resetsAt) return "";
  const mins = Math.max(0, Math.round((new Date(resetsAt).getTime() - Date.now()) / 60_000));
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `resets in ${hours}h ${mins % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function usePlanUsage(enabled: boolean): PlanUsage | null {
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      getJson<PlanUsage>("/usage")
        .then((u) => !cancelled && setUsage(u))
        .catch(() => {});
    void load();
    const t = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [enabled]);
  return enabled ? usage : null;
}

export function Toolbar({
  screen,
  tally,
  running,
  showMeters,
  showContext,
  onCycleMode,
}: {
  screen: ScreenState | null;
  tally: UsageTally;
  running: boolean;
  showMeters: boolean;
  showContext: boolean;
  onCycleMode: () => void;
}) {
  const usage = usePlanUsage(showMeters);
  const mode = screen?.mode;
  const activity = screen?.activity;
  const working = activity?.state === "working";
  const window = contextWindowFor(tally.model);
  const pct = tally.context !== null && window ? Math.round((tally.context / window) * 100) : null;
  const meter = (label: string, w: UsageWindow | null) => {
    if (!w) return null;
    const p = Math.max(0, Math.min(100, Math.round(w.utilization)));
    const level = p >= 90 ? "crit" : p >= 70 ? "warn" : "ok";
    return (
      <div className="cv-meter" title={resetLabel(w.resetsAt)}>
        <div className="cv-meter-row">
          <span>{label}</span>
          <span className="cv-meter-value">{p}%</span>
        </div>
        <div className="cv-meter-track">
          <div className={`cv-meter-fill cv-meter-${level}`} style={{ width: `${p}%` }} />
        </div>
      </div>
    );
  };
  return (
    <div className="cv-toolbar">
      <div className="cv-toolbar-left">
        {running && mode && (
          <button className={`cv-pill cv-mode cv-mode-${mode.id}`} onClick={onCycleMode} title={`${MODE_HINT[mode.id] ?? mode.label}. Click to cycle (Shift+Tab).`}>
            {mode.label}
          </button>
        )}
        {running && screen?.prompt && (
          <span className="cv-pill cv-activity cv-activity-waiting" aria-live="polite">
            Waiting for you
          </span>
        )}
        {running && !screen?.prompt && activity && (
          <span className={`cv-pill cv-activity${working ? " cv-activity-working" : ""}`} aria-live="polite">
            {working ? (
              <>
                <span className="cv-spinner" aria-hidden="true" />
                {activity.label}
                {activity.note ? ` · ${activity.note}` : ""}
                {activity.elapsed ? ` · ${activity.elapsed}` : ""}
                {activity.tokens ? ` · ${activity.tokens} tokens` : ""}
              </>
            ) : activity.verb ? (
              `${activity.verb} for ${activity.elapsed}`
            ) : (
              "Ready"
            )}
          </span>
        )}
        {currentModelLabel(tally) && (
          <span className="cv-pill cv-model" title={tally.switchedTo ? `Switched with /model: ${tally.switchedTo}` : (tally.model ?? undefined)}>
            {currentModelLabel(tally)}
          </span>
        )}
        {!running && <span className="cv-pill cv-closed">Not running in this window</span>}
        {screen?.stale && <span className="cv-pill cv-stale" title={screen.error ?? undefined}>Screen unreadable</span>}
      </div>
      <div className="cv-toolbar-right">
        {showContext && tally.context !== null && (
          <span className="cv-stat" title={`Context used by the last turn${tally.model ? ` on ${tally.model}` : ""}`}>
            ctx {pct !== null ? `${pct}% · ` : ""}
            {formatTokens(tally.context)}
          </span>
        )}
        {showContext && tally.seen.size > 0 && (
          <span className="cv-stat" title={`Estimated at API rates${tally.unpriced ? `; ${tally.unpriced} messages from unknown models not counted` : ""}. A subscription plan isn't billed per token.`}>
            est. ${tally.cost.toFixed(2)}
          </span>
        )}
        {usage?.available && (
          <div className="cv-meters">
            {meter("5h", usage.fiveHour)}
            {meter("7d", usage.sevenDay)}
          </div>
        )}
      </div>
    </div>
  );
}

export function useSettingValue<T>(key: string, fallback: T, subscribe: (cb: () => void) => () => void): T {
  const [value, setValue] = useState<T>(() => setting(key, fallback));
  useEffect(() => subscribe(() => setValue(setting(key, fallback))), [key, subscribe]);
  return value;
}
