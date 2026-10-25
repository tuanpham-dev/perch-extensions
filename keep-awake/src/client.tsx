// keep-awake client: a status bar item whose popover picks how the server's
// computer is kept awake (server.js does the keeping), and, per device, keeps
// this screen on too while it is. One poller feeds the item and the popover.
import { useEffect, useState, type ReactNode } from "react";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";

type Mode = "on" | "agent" | "off";

interface KeepAwakeState {
  mode: Mode;
  // Holding the computer awake right now.
  active: boolean;
  // Why it couldn't (no systemd-inhibit, say), and a caveat when it holds
  // less than it would like (Linux outside a desktop session).
  error: string | null;
  note: string | null;
  hostname: string;
  working: number;
  idleForMs: number | null;
}

const CHOICES: { mode: Mode; label: string; detail: string }[] = [
  { mode: "on", label: "On", detail: "Keep this computer awake continuously" },
  { mode: "agent", label: "Agent", detail: "Stay awake while an agent is working" },
  { mode: "off", label: "Off", detail: "Allow normal system sleep behavior" },
];

const POLL_MS = 10_000;
const SCREEN_KEY = "perch.keep-awake.screen";

// ---- The state, polled once for everyone ----

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let current: KeepAwakeState | null = null;
const listeners = new Set<() => void>();
let timer: number | undefined;

function publish(next: KeepAwakeState | null) {
  current = next;
  for (const fn of listeners) fn();
}

async function poll() {
  if (!serverFetch || document.hidden) return;
  try {
    const res = await serverFetch("/state");
    if (res.ok) publish((await res.json()) as KeepAwakeState);
  } catch {
    // The server went away for a moment: keep showing what it last said.
  }
}

async function setMode(mode: Mode) {
  if (!serverFetch) return;
  const res = await serverFetch("/mode", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (res.ok) publish((await res.json()) as KeepAwakeState);
}

const onVisible = () => {
  if (!document.hidden) void poll();
};

function useKeepAwake(): KeepAwakeState | null {
  const [, rerender] = useState(0);
  useEffect(() => {
    const fn = () => rerender((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return current;
}

// ---- This screen, per device ----
// A page can't keep its own computer from sleeping, only its screen on, and
// only while it's the tab in front: the lock goes when the tab is hidden and
// is taken again when it's back.

function loadScreen(): boolean {
  try {
    return localStorage.getItem(SCREEN_KEY) === "1";
  } catch {
    return false;
  }
}

let screenWanted = loadScreen();
let lock: WakeLockSentinel | null = null;
let requesting = false;

function wakeLockSupported(): boolean {
  return "wakeLock" in navigator;
}

function applyScreen() {
  const want = screenWanted && current?.active === true && !document.hidden;
  if (want && !lock && !requesting && wakeLockSupported()) {
    requesting = true;
    navigator.wakeLock.request("screen").then(
      (sentinel) => {
        requesting = false;
        lock = sentinel;
        sentinel.addEventListener("release", () => {
          if (lock === sentinel) lock = null;
        });
        // Wanted no longer by the time it arrived.
        if (!(screenWanted && current?.active)) releaseScreen();
      },
      () => {
        requesting = false;
      },
    );
  } else if (!want && lock) {
    releaseScreen();
  }
}

function releaseScreen() {
  const held = lock;
  lock = null;
  void held?.release();
}

function setScreen(on: boolean) {
  screenWanted = on;
  try {
    localStorage.setItem(SCREEN_KEY, on ? "1" : "0");
  } catch {
    // private window: it lasts until the page closes
  }
  applyScreen();
  for (const fn of listeners) fn();
}

// ---- The popover ----

function Codicon({ name }: { name: string }) {
  return <span className={`codicon codicon-${name}`} aria-hidden="true" />;
}

function statusLine(state: KeepAwakeState): string {
  if (state.error) return state.error;
  if (!state.active) return `${state.hostname} can sleep as usual`;
  return `Keeping ${state.hostname} awake${state.note ? ` (${state.note})` : ""}`;
}

function KeepAwakePopover() {
  const state = useKeepAwake();
  const [busy, setBusy] = useState(false);
  if (!state) return <div className="keep-awake-popover keep-awake-empty">Reading…</div>;
  const choose = (mode: Mode) => {
    setBusy(true);
    setMode(mode)
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return (
    <div className="keep-awake-popover">
      <div className="keep-awake-header">
        <span className="keep-awake-title">Keep Awake</span>
        <span className="keep-awake-now">{statusLine(state)}</span>
      </div>
      <div role="radiogroup" aria-label="Keep Awake">
        {CHOICES.map((c) => (
          <button
            key={c.mode}
            type="button"
            role="radio"
            aria-checked={state.mode === c.mode}
            disabled={busy}
            className={`keep-awake-choice${state.mode === c.mode ? " selected" : ""}`}
            onClick={() => choose(c.mode)}
          >
            <span className="keep-awake-check">{state.mode === c.mode && <Codicon name="check" />}</span>
            <span className="keep-awake-text">
              <span className="keep-awake-label">{c.label}</span>
              <span className="keep-awake-detail">{c.detail}</span>
            </span>
          </button>
        ))}
      </div>
      {wakeLockSupported() && (
        <label className="keep-awake-screen">
          <input type="checkbox" checked={screenWanted} onChange={(e) => setScreen(e.target.checked)} />
          <span className="keep-awake-text">
            <span>Keep this screen on too</span>
            <span className="keep-awake-detail">While it's kept awake and Perch is in front, on this device</span>
          </span>
        </label>
      )}
    </div>
  );
}

// ---- Status bar item ----

interface StatusItemContext {
  openPopover(anchor: DOMRect, content: ReactNode): void;
  closePopover?(): void;
}

function KeepAwakeItem({ context }: { context: StatusItemContext }) {
  const state = useKeepAwake();
  const label = CHOICES.find((c) => c.mode === state?.mode)?.label ?? "Off";
  const title = state ? `Keep Awake: ${label} - ${statusLine(state)}` : "Keep Awake";
  return (
    <button
      className={`status-bar-item${state?.active ? " active" : ""}`}
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
const screenListener = () => applyScreen();

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerStatusBarItem({ id: "keep-awake", title: "Keep Awake", placement: "right", component: KeepAwakeItem });
  listeners.add(screenListener);
  document.addEventListener("visibilitychange", onVisible);
  document.addEventListener("visibilitychange", screenListener);
  void poll();
  timer = window.setInterval(() => void poll(), POLL_MS);
}

export function deactivate(): void {
  window.clearInterval(timer);
  timer = undefined;
  document.removeEventListener("visibilitychange", onVisible);
  document.removeEventListener("visibilitychange", screenListener);
  listeners.clear();
  releaseScreen();
  removeStylesheet?.();
  removeStylesheet = null;
  serverFetch = null;
  current = null;
}
