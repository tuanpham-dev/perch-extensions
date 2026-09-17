// Keeps the parsed screen of every terminal window running Claude Code, on
// the server, whether or not a tab is open. That is what lets a push
// notification go out and the window row show a waiting icon with no browser
// looking, and it means one screen read per window per tick however many tabs
// watch it.
//
// Each window's state carries an epoch that goes up whenever something a tab
// shows changes (mode, activity, the prompt and its cursor or checkboxes, or
// the raw screen while it is unmodeled). A tab long-polls wait(windowId,
// epoch) and re-renders when it returns.
//
// The loop reads every Claude window each `claudeViewer.pollInterval` ms. An
// agent hook event for a window reads that window at once and speeds the loop
// up for a few seconds, so a prompt shows well inside the interval when hooks
// are installed.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseScreen, promptSignature } from "./screen.mjs";

const PLANS_DIR = path.join(os.homedir(), ".claude", "plans");

// The plan prompt's footer names the plan file ("ctrl+g to edit in Nvim ·
// ~/.claude/plans/<name>.md"). Its own markdown beats the screen's copy,
// which the terminal has wrapped and stripped of formatting. Only files
// directly inside ~/.claude/plans are read.
async function planFromFooter(footer) {
  const m = /~\/\.claude\/plans\/([\w.-]+\.md)\b/.exec(footer ?? "");
  if (!m) return null;
  try {
    const text = await readFile(path.join(PLANS_DIR, path.basename(m[1])), "utf8");
    return text.trim() ? { text: text.trim(), truncated: false, file: `~/.claude/plans/${path.basename(m[1])}` } : null;
  } catch {
    return null;
  }
}

const SCROLLBACK_LINES = 60;
// A plan can be longer than the normal read; its prompt gets one deeper read.
const PLAN_SCROLLBACK_LINES = 400;
const BOOST_MS = 10_000;
const BOOST_INTERVAL_MS = 500;
const PROGRAMS_TTL_MS = 30_000;
// How long after the conversation area last changed a window still counts as
// working when no spinner or "done" line says otherwise.
const STREAMING_GRACE_MS = 2500;
// A prompt-submit hook means a turn is starting, before its spinner shows.
// Once a spinner shows, the spinner and the streaming check take over; an
// interrupt fires no stop hook, so the hook state also expires after this long.
const HOOK_BUSY_MAX_MS = 15_000;
const MAX_WAIT_MS = 25_000;
// After a Stop from the tab, screen changes this soon are the interrupt's own
// output.
const INTERRUPT_QUIET_MS = 2000;

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Which foreground commands are Claude Code: the registry's Claude agents
// (Settings -> AI Providers), plus "claude" itself so a core without the
// registry still works.
export function claudePrograms(agents) {
  const programs = new Set(["claude"]);
  for (const agent of agents ?? []) {
    if (!agent?.program) continue;
    const base = String(agent.program).split(/[\\/]/).pop();
    if (base === "claude" || /claude/i.test(String(agent.id ?? ""))) programs.add(agent.program);
  }
  return programs;
}

// What a tab would redraw for. Elapsed seconds are included on purpose: the
// activity pill counts up.
function viewKey(screen) {
  const p = screen.prompt;
  return JSON.stringify([
    screen.mode?.id ?? null,
    screen.mode?.label ?? null,
    screen.activity,
    p ? promptSignature(p) : null,
    p ? p.options.map((o) => [o.cursor, o.checked]) : null,
    p?.tabs ?? null,
    screen.input?.text ?? null,
    screen.unmodeled ? screen.tail : null,
  ]);
}

export function createWatcher({ host, log, getSettings }) {
  const windows = new Map();
  const waiters = new Map();
  // A window's epoch keeps counting when Claude exits and starts again in it,
  // so a tab that saw the closed state still accepts the new one.
  const retiredEpochs = new Map();
  const fresh = (info) => ({
    ...info,
    epoch: (retiredEpochs.get(info.windowId) ?? 0) + 1,
    key: "",
    screen: null,
    stale: false,
    misses: 0,
    promptSignature: "",
    promptSince: null,
    notifiedSignature: null,
    updatedAt: 0,
    closed: false,
  });
  let programs = { at: 0, value: new Set(["claude"]) };
  let timer = null;
  let stopped = false;
  let boostUntil = 0;
  let unsubscribe = null;
  let ticking = null;

  async function settings() {
    let s = {};
    try {
      s = (await getSettings?.()) ?? {};
    } catch {
      // Defaults below.
    }
    return {
      pollInterval: num(s["claudeViewer.pollInterval"], 1000, 250, 10_000),
      pushNotifications: s["claudeViewer.pushNotifications"] !== false,
      stripLines: num(s["claudeViewer.screenStripLines"], 12, 4, 40),
    };
  }

  async function currentPrograms() {
    if (Date.now() - programs.at < PROGRAMS_TTL_MS) return programs.value;
    let agents = null;
    try {
      agents = (await host.agents?.list()) ?? null;
    } catch {
      // A core without the registry: "claude" alone.
    }
    programs = { at: Date.now(), value: claudePrograms(agents) };
    return programs.value;
  }

  function wake(windowId) {
    const set = waiters.get(windowId);
    if (!set) return;
    waiters.delete(windowId);
    for (const resolve of set) resolve();
  }

  async function discover() {
    const progs = await currentPrograms();
    let sessions = [];
    try {
      sessions = await host.sessions.list();
    } catch (err) {
      log?.(`claude-viewer: listing sessions failed: ${err.message}`);
      return null;
    }
    const found = new Map();
    for (const session of sessions) {
      for (const win of session.windows ?? []) {
        if (!progs.has(win.command)) continue;
        found.set(win.id, {
          windowId: win.id,
          sessionName: session.name,
          windowIndex: win.index,
          windowName: win.name,
          cwd: win.cwd || session.path,
          command: win.command,
        });
      }
    }
    return found;
  }

  async function read(entry, opts) {
    let text;
    try {
      // With styles: color is all that marks the active question tab. A Perch
      // without styled captures returns plain text, which reads the same.
      text = await host.sessions.capture(entry.windowId, { scrollback: SCROLLBACK_LINES, styles: true });
    } catch (err) {
      entry.misses = (entry.misses ?? 0) + 1;
      if (entry.misses >= 2 && !entry.stale) {
        entry.stale = true;
        entry.error = err.message;
        entry.epoch++;
        wake(entry.windowId);
      }
      return;
    }
    let screen = parseScreen(text, { stripLines: opts.stripLines });
    const fromFile = screen.prompt?.kind === "plan" ? await planFromFooter(screen.prompt.footer) : null;
    if (fromFile) screen = { ...screen, prompt: { ...screen.prompt, plan: fromFile } };
    else if (screen.prompt?.kind === "plan" && screen.prompt.plan?.truncated) {
      try {
        const deep = await host.sessions.capture(entry.windowId, { scrollback: PLAN_SCROLLBACK_LINES, styles: true });
        screen = parseScreen(deep, { stripLines: opts.stripLines });
      } catch {
        // Keep the shallow read.
      }
    }
    entry.misses = 0;
    const wasStale = entry.stale;
    entry.stale = false;
    entry.error = null;
    entry.updatedAt = Date.now();
    const signature = screen.prompt ? promptSignature(screen.prompt) : "";
    const newPrompt = signature !== "" && signature !== entry.promptSignature;
    entry.promptSignature = signature;
    if (newPrompt) entry.promptSince = Date.now();
    if (!signature) entry.promptSince = null;
    // A prompt or picker covers the footer; the mode it hides hasn't changed.
    if (!screen.mode && entry.screen?.mode) screen = { ...screen, mode: entry.screen.mode };
    // Busy without a spinner: a streaming text reply (the conversation area
    // keeps changing), or a turn the hooks say started and hasn't stopped.
    const now = Date.now();
    if (screen.conversationFingerprint && screen.conversationFingerprint !== entry.fingerprint) {
      if (entry.fingerprint !== undefined && !(entry.quietUntil > now)) entry.changedAt = now;
      entry.fingerprint = screen.conversationFingerprint;
    }
    if (screen.activity?.state === "working") entry.hookBusySince = undefined;
    const noVerdict = screen.activity?.state === "idle" && !screen.activity.verb;
    const streaming = entry.changedAt !== undefined && now - entry.changedAt < STREAMING_GRACE_MS;
    const hookBusy = entry.hookBusySince !== undefined && now - entry.hookBusySince < HOOK_BUSY_MAX_MS;
    if (noVerdict && !screen.prompt && (streaming || hookBusy)) {
      screen = { ...screen, activity: { state: "working", label: "Writing", elapsed: null, tokens: null, note: null } };
    }
    entry.screen = screen;
    // Keyed after the overlay, so the overlay ending wakes waiting tabs too.
    const key = viewKey(screen);
    if (key !== entry.key || wasStale) {
      entry.key = key;
      entry.epoch++;
      wake(entry.windowId);
    }
    if (newPrompt && opts.pushNotifications && entry.notifiedSignature !== signature) {
      entry.notifiedSignature = signature;
      const p = screen.prompt;
      const heading = p.kind === "permission" ? `${p.title}: ${p.question ?? "waiting"}` : p.question ?? p.title ?? "Claude is waiting";
      host.notifications
        ?.push({ title: "Claude is waiting", body: `${heading} - ${entry.sessionName}`, windowId: entry.windowId })
        .catch(() => {});
    }
    if (!signature) entry.notifiedSignature = null;
  }

  async function tick() {
    const opts = await settings();
    const found = await discover();
    if (found) {
      for (const id of [...windows.keys()]) {
        if (!found.has(id)) {
          const gone = windows.get(id);
          windows.delete(id);
          gone.epoch++;
          gone.closed = true;
          retiredEpochs.set(id, gone.epoch);
          wake(id);
        }
      }
      for (const [id, info] of found) {
        const entry = windows.get(id);
        if (entry) Object.assign(entry, info);
        else windows.set(id, fresh(info));
      }
    }
    await Promise.all([...windows.values()].map((entry) => read(entry, opts)));
    return opts;
  }

  function schedule(opts) {
    if (stopped) return;
    const interval = Date.now() < boostUntil ? Math.min(BOOST_INTERVAL_MS, opts.pollInterval) : opts.pollInterval;
    timer = setTimeout(loop, interval);
    timer.unref?.();
  }

  async function loop() {
    timer = null;
    let opts = { pollInterval: 1000 };
    try {
      ticking = tick();
      opts = await ticking;
    } catch (err) {
      log?.(`claude-viewer: watcher tick failed: ${err.message}`);
    } finally {
      ticking = null;
    }
    schedule(opts);
  }

  // Read one window now (after a key press, or a hook event). A window not
  // seen yet triggers discovery first.
  async function refresh(windowId) {
    const opts = await settings();
    if (!windows.has(windowId)) {
      const found = await discover();
      const info = found?.get(windowId);
      if (!info) return null;
      windows.set(windowId, fresh(info));
    }
    const entry = windows.get(windowId);
    await read(entry, opts);
    return entry;
  }

  function publicState(entry) {
    if (!entry) return null;
    return {
      windowId: entry.windowId,
      sessionName: entry.sessionName,
      windowIndex: entry.windowIndex,
      windowName: entry.windowName,
      cwd: entry.cwd,
      epoch: entry.epoch,
      updatedAt: entry.updatedAt,
      stale: entry.stale,
      error: entry.error ?? null,
      closed: entry.closed === true,
      promptSince: entry.promptSince,
      ...(entry.screen ?? { mode: null, activity: null, prompt: null, input: null, unmodeled: false, tail: "" }),
    };
  }

  unsubscribe =
    host.agentHooks?.subscribe({
      events: ["permission", "prompt-submit", "stop", "tool-start", "tool-end", "session-start"],
      onEvent(event) {
        boostUntil = Date.now() + BOOST_MS;
        const target = event?.paneId ? windows.get(event.paneId) : null;
        if (target) {
          if (event.event === "prompt-submit") target.hookBusySince = Date.now();
          else if (event.event === "stop") target.hookBusySince = undefined;
        }
        const id = event?.paneId;
        if (!id) return;
        const at = Date.now();
        void refresh(id)
          .then((entry) => {
            if (entry && event.event === "permission") {
              log?.(`claude-viewer: hook ${event.event} at ${at} -> screen read in ${Date.now() - at} ms (prompt: ${entry.screen?.prompt?.kind ?? "none"})`);
            }
          })
          .catch(() => {});
      },
    }) ?? null;

  void loop();

  return {
    get: (windowId) => publicState(windows.get(windowId)),
    list: () => [...windows.values()].map(publicState),
    refresh: async (windowId) => publicState(await refresh(windowId)),
    // The turn was interrupted from here: no stop hook follows, and the
    // "Interrupted" line it prints is not Claude writing.
    interrupted(windowId) {
      const entry = windows.get(windowId);
      if (!entry) return;
      entry.hookBusySince = undefined;
      entry.changedAt = undefined;
      // What the interrupt itself prints is not Claude writing.
      entry.quietUntil = Date.now() + INTERRUPT_QUIET_MS;
    },
    async wait(windowId, epoch, timeoutMs = MAX_WAIT_MS) {
      const entry = windows.get(windowId);
      if (!entry || entry.epoch > epoch) return publicState(entry) ?? (await refresh(windowId).then(publicState));
      await new Promise((resolve) => {
        let set = waiters.get(windowId);
        if (!set) {
          set = new Set();
          waiters.set(windowId, set);
        }
        const done = () => {
          clearTimeout(t);
          set.delete(done);
          resolve();
        };
        const t = setTimeout(done, Math.min(MAX_WAIT_MS, Math.max(1000, timeoutMs)));
        set.add(done);
      });
      return publicState(windows.get(windowId)) ?? { windowId, closed: true, epoch: Math.max(epoch, retiredEpochs.get(windowId) ?? 0) };
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      for (const id of [...waiters.keys()]) wake(id);
    },
  };
}
