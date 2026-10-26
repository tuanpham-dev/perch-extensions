// keep-awake client: a status bar item whose popover picks how this device
// is kept awake, per device. A page can't stop its computer sleeping
// outright, but a screen wake lock does: while the screen is kept on the
// computer doesn't idle into sleep. Browsers only grant it while the page is
// the tab in front, so it's taken again whenever Perch is back in front. For
// "Agent", server.js says whether an agent is working.
import { useEffect, useState, type ReactNode } from "react";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";
import { wantsAwake } from "../activity.mjs";

type Mode = "on" | "agent" | "off";

interface Activity {
  working: number;
  idleForMs: number | null;
}

const CHOICES: { mode: Mode; label: string; detail: string }[] = [
  { mode: "on", label: "On", detail: "Keep this computer awake continuously" },
  { mode: "agent", label: "Agent", detail: "Stay awake while an agent is working" },
  { mode: "off", label: "Off", detail: "Allow normal system sleep behavior" },
];

const MODES: Mode[] = ["on", "agent", "off"];
const POLL_MS = 10_000;
const MODE_KEY = "perch.keep-awake.mode";

// ---- State, shared by the item and the popover ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let mode: Mode = loadMode();
let activity: Activity | null = null;
let lock: WakeLockSentinel | null = null;
let requesting = false;
// Why the last request for a lock was refused (battery saver, say).
let refused: string | null = null;
const listeners = new Set<() => void>();
let timer: number | undefined;

function loadMode(): Mode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    return MODES.includes(stored as Mode) ? (stored as Mode) : "off";
  } catch {
    return "off";
  }
}

function changed() {
  for (const fn of listeners) fn();
}

function supported(): boolean {
  return "wakeLock" in navigator;
}

function wanted(): boolean {
  return wantsAwake(mode, activity ?? { working: 0, idleForMs: null });
}

function apply() {
  const want = wanted() && !document.hidden;
  if (want && !lock && !requesting && supported()) {
    requesting = true;
    navigator.wakeLock.request("screen").then(
      (sentinel) => {
        requesting = false;
        refused = null;
        lock = sentinel;
        sentinel.addEventListener("release", () => {
          if (lock === sentinel) lock = null;
          changed();
        });
        // Wanted no longer by the time it arrived.
        if (!wanted() || document.hidden) release();
        changed();
      },
      (err: unknown) => {
        requesting = false;
        refused = err instanceof Error ? err.message : String(err);
        changed();
      },
    );
  } else if (!want && lock) {
    release();
  }
}

function release() {
  const held = lock;
  lock = null;
  void held?.release();
}

async function poll() {
  if (!serverFetch || mode !== "agent" || document.hidden) return;
  try {
    const res = await serverFetch("/state");
    if (res.ok) {
      activity = (await res.json()) as Activity;
      apply();
      changed();
    }
  } catch {
    // The server went away for a moment: keep going on what it last said.
  }
}

function setMode(next: Mode) {
  mode = next;
  refused = null;
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {
    // private window: it lasts until the page closes
  }
  apply();
  changed();
  void poll();
}

const onVisible = () => {
  apply();
  changed();
  void poll();
};

function useKeepAwake(): void {
  const [, rerender] = useState(0);
  useEffect(() => {
    const fn = () => rerender((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
}

// ---- The popover ----

function Codicon({ name }: { name: string }) {
  return <span className={`codicon codicon-${name}`} aria-hidden="true" />;
}

function statusLine(): string {
  if (mode === "off") return "This computer can sleep as usual";
  if (!supported()) {
    return window.isSecureContext
      ? "This browser can't keep the computer awake"
      : "Needs a secure page (https:// or localhost) to keep this computer awake";
  }
  if (!wanted()) return activity ? "No agent working, this computer can sleep as usual" : "Checking on agents…";
  if (refused) return `The browser refused: ${refused}`;
  if (lock) return "Keeping this computer awake";
  return "Paused while Perch isn't the tab in front";
}

function KeepAwakePopover() {
  useKeepAwake();
  return (
    <div className="keep-awake-popover">
      <div className="keep-awake-header">
        <span className="keep-awake-title">Keep Awake</span>
        <span className="keep-awake-now">{statusLine()}</span>
      </div>
      <div role="radiogroup" aria-label="Keep Awake">
        {CHOICES.map((c) => (
          <button
            key={c.mode}
            type="button"
            role="radio"
            aria-checked={mode === c.mode}
            className={`keep-awake-choice${mode === c.mode ? " selected" : ""}`}
            onClick={() => setMode(c.mode)}
          >
            <span className="keep-awake-check">{mode === c.mode && <Codicon name="check" />}</span>
            <span className="keep-awake-text">
              <span className="keep-awake-label">{c.label}</span>
              <span className="keep-awake-detail">{c.detail}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="keep-awake-footer">On this device only, while Perch is the tab or window in front</div>
    </div>
  );
}

// ---- Status bar item ----

interface StatusItemContext {
  openPopover(anchor: DOMRect, content: ReactNode): void;
  closePopover?(): void;
}

function KeepAwakeItem({ context }: { context: StatusItemContext }) {
  useKeepAwake();
  const label = CHOICES.find((c) => c.mode === mode)?.label ?? "Off";
  const title = `Keep Awake: ${label} - ${statusLine()}`;
  return (
    <button
      className={`status-bar-item${lock ? " active" : ""}`}
      data-menu-trigger="true"
      aria-haspopup="dialog"
      title={title}
      aria-label={title}
      // openPopover toggles: the host keys it on this item's id.
      onClick={(e) => context.openPopover(e.currentTarget.getBoundingClientRect(), <KeepAwakePopover />)}
    >
      <Codicon name="coffee" />
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
    component: (props: { context: StatusItemContext }) => ReturnType<typeof KeepAwakeItem>;
  }): void;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
}

let removeStylesheet: (() => void) | null = null;

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerStatusBarItem({ id: "keep-awake", title: "Keep Awake", placement: "right", component: KeepAwakeItem });
  document.addEventListener("visibilitychange", onVisible);
  apply();
  void poll();
  timer = window.setInterval(() => void poll(), POLL_MS);
}

export function deactivate(): void {
  window.clearInterval(timer);
  timer = undefined;
  document.removeEventListener("visibilitychange", onVisible);
  listeners.clear();
  release();
  removeStylesheet?.();
  removeStylesheet = null;
  serverFetch = null;
  activity = null;
}
