// What the tab shows about the session outside the conversation: Claude's
// activity, in the terminal screen bar at the bottom of the tab, and the
// context, estimated cost and plan limits, compact in the composer's bottom row
// with the full figures in a panel they open.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

// One small glyph per mode, in the label's text color: a spark for auto, the
// terminal's pause bars for manual, a pencil for accept edits, a checklist
// for plan, fast-forward for bypass permissions (the terminal's ⏵⏵); a dot
// for wording we don't know.
const MODE_ICON: Record<string, JSX.Element> = {
  auto: <path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z" fill="currentColor" stroke="none" />,
  manual: (
    <>
      <path d="M6 4v8" />
      <path d="M10 4v8" />
    </>
  ),
  acceptEdits: (
    <>
      <path d="M10.5 3.5l2 2L6 12H4v-2z" />
      <path d="M9 5l2 2" />
    </>
  ),
  plan: (
    <>
      <path d="M3 4.5l1 1 1.8-2" />
      <path d="M3 10.5l1 1 1.8-2" />
      <path d="M8 5h5" />
      <path d="M8 11h5" />
    </>
  ),
  bypassPermissions: <path d="M1.5 3.5l6 4.5-6 4.5zM8.5 3.5l6 4.5-6 4.5z" fill="currentColor" stroke="none" />,
};

export function ModeIcon({ id }: { id: string }) {
  return (
    <svg className="cv-mode-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {MODE_ICON[id] ?? <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />}
    </svg>
  );
}

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
// plan limits as stacked bars, 5-hour on top. Either one opens a panel with
// the full figures: a tooltip needs a mouse, and on a phone there is none.
export function UsageStats({ tally, showContext, showMeters }: { tally: UsageTally; showContext: boolean; showMeters: boolean }) {
  const usage = usePlanUsage(showMeters);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  const contextWindow = contextWindowFor(tally.model);
  const hasContext = showContext && tally.context !== null;
  const hasCost = showContext && tally.seen.size > 0;
  const pct = hasContext && contextWindow ? Math.min(100, Math.round((tally.context! / contextWindow) * 100)) : null;
  const limits = usage?.available ? ([["5-hour", usage.fiveHour], ["7-day", usage.sevenDay]] as const) : null;
  const hasLimits = Boolean(limits && (limits[0][1] || limits[1][1]));

  // Closes on a tap anywhere else, and on Esc (see closeFooterPopover).
  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const onDown = (e: PointerEvent) => {
      if (!root?.contains(e.target as Node)) setOpen(false);
    };
    const onClose = () => setOpen(false);
    document.addEventListener("pointerdown", onDown);
    root?.addEventListener(CLOSE_EVENT, onClose);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      root?.removeEventListener(CLOSE_EVENT, onClose);
    };
  }, [open]);

  // The panel hangs from the right edge of these indicators, which on a phone
  // sit mid-row; slide it right if its left edge would leave the screen.
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const rect = panelRef.current?.getBoundingClientRect();
    if (rect && rect.left - shift < 8) setShift(8 - (rect.left - shift));
    // Measured once per opening; `shift` is only read to undo the last one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!hasContext && !hasCost && !hasLimits) return null;

  // The ring's circumference is 2πr with r = 5.
  const ring = 2 * Math.PI * 5;
  const toggle = () => setOpen((o) => !o);
  return (
    <div className="cv-usage-pop" ref={rootRef} data-open={open || undefined}>
      {(hasContext || hasCost) && (
        <button type="button" className="cv-foot-btn cv-usage" aria-expanded={open} aria-haspopup="dialog" onClick={toggle} title="Context and cost">
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
        </button>
      )}
      {hasLimits && (
        <button type="button" className="cv-foot-btn cv-limits" aria-expanded={open} aria-haspopup="dialog" onClick={toggle} title="Plan limits">
          {limits!.map(([label, w]) => {
            const p = w ? Math.max(0, Math.min(100, Math.round(w.utilization))) : 0;
            return (
              <span key={label} className="cv-limit-track">
                <span className={`cv-limit-fill cv-level-${levelOf(p)}`} style={{ width: `${p}%` }} />
              </span>
            );
          })}
        </button>
      )}
      {open && (
        <div className="cv-foot-panel cv-usage-panel" role="dialog" aria-label="Usage" ref={panelRef} style={shift ? { right: -shift } : undefined}>
          {hasContext && (
            <section className="cv-usage-row">
              <div className="cv-usage-row-top">
                <strong>Context</strong>
                <span>{pct !== null ? `${pct}%` : `${formatTokens(tally.context!)} tokens`}</span>
              </div>
              {pct !== null && <Meter pct={pct} />}
              <div className="cv-usage-row-desc">
                {tally.context!.toLocaleString()} tokens used by the last turn
                {contextWindow ? ` of ${formatTokens(contextWindow)}` : ""}
                {tally.model ? ` (${tally.model})` : ""}
              </div>
            </section>
          )}
          {hasCost && (
            <section className="cv-usage-row">
              <div className="cv-usage-row-top">
                <strong>Estimated cost</strong>
                <span>${tally.cost.toFixed(2)}</span>
              </div>
              <div className="cv-usage-row-desc">
                At API rates{tally.unpriced ? `, not counting ${tally.unpriced} messages from unknown models` : ""}. A subscription plan isn't billed per token.
              </div>
            </section>
          )}
          {hasLimits &&
            limits!
              .filter(([, w]) => w)
              .map(([label, w]) => {
                const p = Math.max(0, Math.min(100, Math.round(w!.utilization)));
                return (
                  <section key={label} className="cv-usage-row">
                    <div className="cv-usage-row-top">
                      <strong>{label} limit</strong>
                      <span>{p}% used</span>
                    </div>
                    <Meter pct={p} />
                    {w!.resetsAt && <div className="cv-usage-row-desc">{capitalize(resetLabel(w!.resetsAt))}</div>}
                  </section>
                );
              })}
        </div>
      )}
    </div>
  );
}

function Meter({ pct }: { pct: number }) {
  return (
    <span className="cv-usage-meter">
      <span className={`cv-limit-fill cv-level-${levelOf(pct)}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// A footer popover (the usage panel, the agents list) listens for this to
// close.
export const CLOSE_EVENT = "cv-close-popover";

// Whether an Esc should go to an open footer popover: closes it and says so,
// so the same Esc never also stops Claude.
export function closeFooterPopover(root: HTMLElement | null): boolean {
  const open = root?.querySelector(".cv-usage-pop[data-open], .cv-agents[data-open]");
  if (!open) return false;
  open.dispatchEvent(new Event(CLOSE_EVENT));
  return true;
}
