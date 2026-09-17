// What the tab shows about the session outside the conversation: Claude's
// activity, in the terminal screen bar at the bottom of the tab, and the
// context, estimated cost and plan limits, compact in the composer's bottom row
// with the full figures in their tooltips.
import { useEffect, useState } from "react";
import { getJson } from "./bridge";
import type { ScreenState } from "./types";
import { contextWindowFor, formatTokens, type UsageTally } from "./usage";

type UsageWindow = { utilization: number; resetsAt: string | null };
type PlanUsage = { available: boolean; fiveHour: UsageWindow | null; sevenDay: UsageWindow | null };

export const MODE_HINT: Record<string, string> = {
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

const levelOf = (pct: number) => (pct >= 90 ? "crit" : pct >= 70 ? "warn" : "ok");

// Claude's activity as one line: waiting on a prompt, working (with its
// elapsed time and tokens), how long the last turn took, or a screen that
// can't be read. Null when there is nothing to say.
export function ActivityStatus({ screen, running }: { screen: ScreenState | null; running: boolean }) {
  if (!running || !screen) return null;
  if (screen.stale) {
    return (
      <span className="cv-status cv-status-stale" title={screen.error ?? undefined}>
        Screen unreadable
      </span>
    );
  }
  if (screen.prompt) return <span className="cv-status cv-status-waiting">Waiting for you</span>;
  const activity = screen.activity;
  if (!activity) return null;
  if (activity.state === "working") {
    const text = [activity.label, activity.note, activity.elapsed, activity.tokens ? `${activity.tokens} tokens` : null].filter(Boolean).join(" · ");
    return (
      <span className="cv-status cv-status-working" title={text}>
        <span className="cv-spinner" aria-hidden="true" />
        <span className="cv-status-text">{text}</span>
      </span>
    );
  }
  return <span className="cv-status">{activity.verb ? `${activity.verb} for ${activity.elapsed}` : "Ready"}</span>;
}

// A ring filled to the context used, a dot, the estimated cost; then the two
// plan limits as stacked bars, 5-hour on top.
export function UsageStats({ tally, showContext, showMeters }: { tally: UsageTally; showContext: boolean; showMeters: boolean }) {
  const usage = usePlanUsage(showMeters);
  const contextWindow = contextWindowFor(tally.model);
  const hasContext = showContext && tally.context !== null;
  const hasCost = showContext && tally.seen.size > 0;
  const pct = hasContext && contextWindow ? Math.min(100, Math.round((tally.context! / contextWindow) * 100)) : null;
  const limits = usage?.available ? ([["5-hour", usage.fiveHour], ["7-day", usage.sevenDay]] as const) : null;

  const contextTitle = [
    hasContext
      ? `Context used by the last turn: ${pct !== null ? `${pct}% of ${formatTokens(contextWindow!)}, ` : ""}${tally.context!.toLocaleString()} tokens${tally.model ? ` (${tally.model})` : ""}`
      : null,
    hasCost
      ? `Estimated cost: $${tally.cost.toFixed(2)} at API rates${tally.unpriced ? `, not counting ${tally.unpriced} messages from unknown models` : ""}. A subscription plan isn't billed per token.`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  // The ring's circumference is 2πr with r = 5.
  const ring = 2 * Math.PI * 5;
  return (
    <>
      {(hasContext || hasCost) && (
        <span className="cv-usage" title={contextTitle}>
          {hasContext &&
            (pct !== null ? (
              <svg className={`cv-ring cv-level-${levelOf(pct)}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <circle className="cv-ring-track" cx="7" cy="7" r="5" />
                <circle className="cv-ring-fill" cx="7" cy="7" r="5" strokeDasharray={`${(pct / 100) * ring} ${ring}`} transform="rotate(-90 7 7)" />
              </svg>
            ) : (
              <span>{formatTokens(tally.context!)}</span>
            ))}
          {hasContext && hasCost && <span aria-hidden="true">·</span>}
          {hasCost && <span>${tally.cost.toFixed(2)}</span>}
        </span>
      )}
      {limits && (limits[0][1] || limits[1][1]) && (
        <span
          className="cv-limits"
          title={limits
            .filter(([, w]) => w)
            .map(([label, w]) => `${label} limit: ${Math.round(w!.utilization)}% used${w!.resetsAt ? `, ${resetLabel(w!.resetsAt)}` : ""}`)
            .join("\n")}
        >
          {limits.map(([label, w]) => {
            const p = w ? Math.max(0, Math.min(100, Math.round(w.utilization))) : 0;
            return (
              <span key={label} className="cv-limit-track">
                <span className={`cv-limit-fill cv-level-${levelOf(p)}`} style={{ width: `${p}%` }} />
              </span>
            );
          })}
        </span>
      )}
    </>
  );
}
