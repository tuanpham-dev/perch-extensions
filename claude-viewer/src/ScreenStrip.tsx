// The terminal's own bottom lines with a keypad, for anything the prompt card
// can't model (a settings panel, a new kind of dialog). Collapsed normally;
// opens by itself while the screen is unmodeled and closes again after,
// unless the user opened it.
import { useEffect, useRef, useState } from "react";
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

export function ScreenStrip({ windowId, screen, onState }: { windowId: string; screen: ScreenState; onState: (s: ScreenState) => void }) {
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  // Opens by itself only when the screen stays unmodeled for a moment: a
  // redraw between two known states can read as unmodeled for one tick.
  const [autoOpen, setAutoOpen] = useState(false);
  // Closing the strip while it opened itself keeps it closed until the
  // unmodeled screen goes away.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!screen.unmodeled) {
      setAutoOpen(false);
      setDismissed(false);
      return;
    }
    const t = window.setTimeout(() => setAutoOpen(true), 1200);
    return () => window.clearTimeout(t);
  }, [screen.unmodeled]);
  const open = pinned || (autoOpen && !dismissed);
  const toggle = () => {
    if (open) {
      setPinned(false);
      if (autoOpen) setDismissed(true);
    } else {
      setPinned(true);
    }
  };

  useEffect(() => {
    if (open && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [open, screen.tail]);

  async function press(key: string) {
    setBusy(true);
    try {
      const { data } = await postJson<{ state?: ScreenState }>("/key", { windowId, action: { type: "key", key } });
      if (data?.state) onState(data.state);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`cv-strip${open ? " cv-strip-open" : ""}${autoOpen ? " cv-strip-auto" : ""}`}>
      {/* The whole bar toggles; the button inside keeps it reachable by keyboard. */}
      <div className="cv-strip-head" onClick={toggle}>
        <button
          className="cv-strip-toggle"
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> Terminal screen
        </button>
        {autoOpen && !dismissed && <span className="cv-strip-hint">The terminal shows something this view can't turn into buttons. Use the keys below.</span>}
      </div>
      {open && (
        <>
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
        </>
      )}
    </div>
  );
}
