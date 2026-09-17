// The terminal's own bottom lines with a keypad, for anything the prompt card
// can't model (a settings panel, a new kind of dialog). Collapsed normally;
// opens by itself while the screen is unmodeled and closes again after,
// unless the user opened it. It toggles from a heading bar at the bottom of the
// tab and from an icon in the composer's bottom row (the one to reach when an
// overlay covers the heading), so the open state lives in useScreenStrip.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { postJson } from "./bridge";
import type { ScreenState } from "./types";

const KEYPAD: { key: string; label: string; title: string }[] = [
  { key: "up", label: "↑", title: "Up" },
  { key: "down", label: "↓", title: "Down" },
  { key: "left", label: "←", title: "Left" },
  { key: "right", label: "→", title: "Right" },
  { key: "enter", label: "Enter", title: "Enter" },
  { key: "esc", label: "Esc", title: "Escape" },
  { key: "tab", label: "Tab", title: "Tab" },
  { key: "shiftTab", label: "⇧Tab", title: "Shift+Tab" },
  { key: "backspace", label: "⌫", title: "Backspace" },
  { key: "ctrlC", label: "^C", title: "Ctrl+C" },
];

export type ScreenStripState = {
  open: boolean;
  // Opened by itself for an unmodeled screen, and not closed since.
  attention: boolean;
  toggle: () => void;
};

export function useScreenStrip(screen: ScreenState | null): ScreenStripState {
  const [pinned, setPinned] = useState(false);
  // Opens by itself only when the screen stays unmodeled for a moment: a
  // redraw between two known states can read as unmodeled for one tick.
  const [autoOpen, setAutoOpen] = useState(false);
  // Closing the strip while it opened itself keeps it closed until the
  // unmodeled screen goes away.
  const [dismissed, setDismissed] = useState(false);
  const unmodeled = Boolean(screen?.unmodeled);
  useEffect(() => {
    if (!unmodeled) {
      setAutoOpen(false);
      setDismissed(false);
      return;
    }
    const t = window.setTimeout(() => setAutoOpen(true), 1200);
    return () => window.clearTimeout(t);
  }, [unmodeled]);
  const attention = autoOpen && !dismissed;
  const open = pinned || attention;
  const toggle = () => {
    if (open) {
      setPinned(false);
      if (autoOpen) setDismissed(true);
    } else {
      setPinned(true);
    }
  };
  return { open, attention, toggle };
}

export function ScreenStripToggle({ strip }: { strip: ScreenStripState }) {
  return (
    <button
      className={`cv-foot-btn cv-foot-icon cv-strip-toggle${strip.open ? " cv-strip-toggle-open" : ""}${strip.attention ? " cv-strip-toggle-attn" : ""}`}
      aria-expanded={strip.open}
      aria-controls="cv-strip"
      title={strip.open ? "Hide the terminal screen" : "Show the terminal screen and keys"}
      aria-label="Terminal screen"
      onClick={strip.toggle}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M7 9l3 3-3 3M13 15h4" />
      </svg>
    </button>
  );
}

// The bottom bar, which also carries Claude's activity (status). minHeight is the height of an app overlay band over the
// tab's bottom edge: the bar doubles as the spacer that keeps the band off the
// composer.
export function ScreenStripHeading({ strip, minHeight, status }: { strip: ScreenStripState; minHeight: number; status?: ReactNode }) {
  return (
    // The whole bar toggles; the button inside keeps it reachable by keyboard.
    // Open points up: the screen opens above the bar.
    <div className={`cv-strip-head${strip.attention ? " cv-strip-head-attn" : ""}`} style={minHeight ? { minHeight } : undefined} onClick={strip.toggle}>
      <button
        className="cv-strip-head-toggle"
        aria-expanded={strip.open}
        aria-controls="cv-strip"
        aria-label={strip.open ? "Hide the terminal screen" : "Show the terminal screen"}
        title={strip.open ? "Hide the terminal screen" : "Show the terminal screen and keys"}
        onClick={(e) => {
          e.stopPropagation();
          strip.toggle();
        }}
      >
        <span aria-hidden="true">{strip.open ? "▴" : "▸"}</span>
      </button>
      <span className="cv-strip-head-status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}

export function ScreenStrip({ windowId, screen, strip, onState }: { windowId: string; screen: ScreenState; strip: ScreenStripState; onState: (s: ScreenState) => void }) {
  const [busy, setBusy] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (strip.open && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [strip.open, screen.tail]);

  async function press(key: string) {
    setBusy(true);
    try {
      const { data } = await postJson<{ state?: ScreenState }>("/key", { windowId, action: { type: "key", key } });
      if (data?.state) onState(data.state);
    } finally {
      setBusy(false);
    }
  }

  if (!strip.open) return null;
  return (
    <div className="cv-strip" id="cv-strip">
      {strip.attention && <div className="cv-strip-hint">The terminal shows something this view can't turn into buttons. Use the keys below.</div>}
      <pre ref={preRef} className="cv-strip-screen">
        {screen.tail || " "}
      </pre>
      <div className="cv-keypad" role="group" aria-label="Terminal keys">
        {KEYPAD.map((k) => (
          <button key={k.key} className="cv-key" title={k.title} disabled={busy} onClick={() => void press(k.key)}>
            {k.label}
          </button>
        ))}
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <button key={n} className="cv-key cv-key-digit" disabled={busy} onClick={() => void press(String(n))}>
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}
