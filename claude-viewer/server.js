// claude-viewer server hook. Plain ESM on node builtins, mounted at
// /api/ext/perch.claude-viewer/*.
//
// Three sources, each doing what only it can:
//   - Claude Code's transcript files for the conversation (transcript.mjs)
//   - the window's screen, read through host.sessions.capture, for the mode,
//     the activity line and any prompt waiting on the user (watcher.mjs)
//   - agent hook events, only to read a window's screen sooner
//
// Everything sent back into the terminal goes through
// host.sessions.sendTextToWindow, and every key that answers a prompt is sent
// only after a fresh screen read confirms the prompt the user clicked is still
// the one on screen. No tmux, no child processes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeSessionsByWindow } from "./claudePanes.mjs";
import { listCommands, searchProjectFiles } from "./commands.mjs";
import { MAX_PATHS, resolvePaths } from "./paths.mjs";
import { KEYS, bracketedPaste, cursorStepToward, isKeyName, letterKeyFor, nextKeyForChat, nextKeyForOption } from "./keys.mjs";
import { findSessionFile, freshestSessionFile, projectDirFor, readTranscript, sessionIdOfFile } from "./transcript.mjs";
import { claudePrograms, createWatcher } from "./watcher.mjs";

const RATE_LIMIT_STATE_PATH = path.join(os.homedir(), ".claude", "rate-limit-state.json");
const RATE_LIMIT_STALE_MS = 6 * 60 * 60 * 1000;
// Claude Code's input needs a moment after a paste before Enter counts as
// submit, and after a key before the screen shows its effect.
const SETTLE_MS = 150;
const AFTER_KEY_MS = 120;
const MAX_NAV_STEPS = 12;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let watcher = null;

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function str(value) {
  return typeof value === "string" ? value : "";
}

// Which session a window is running: the CLI's own pid record first (exact,
// even with two Claude windows in one directory), else the newest transcript
// in the window's directory.
async function sessionForWindow(windowId, windowCwd) {
  let live = null;
  try {
    live = (await claudeSessionsByWindow()).get(windowId) ?? null;
  } catch {
    // No /proc or no sessions dir: fall through.
  }
  if (live) {
    const file = await findSessionFile(live.sessionId, live.cwd ?? windowCwd);
    if (file) return { sessionId: live.sessionId, file, cwd: live.cwd ?? windowCwd, live: true };
    // The CLI has started but not written its transcript yet.
    return { sessionId: live.sessionId, file: null, cwd: live.cwd ?? windowCwd, live: true };
  }
  if (!windowCwd) return null;
  const file = await freshestSessionFile(projectDirFor(windowCwd));
  return file ? { sessionId: sessionIdOfFile(file), file, cwd: windowCwd, live: false } : null;
}

async function windowInfo(host, windowId) {
  const known = watcher?.get(windowId);
  if (known) return known;
  const sessions = await host.sessions.list();
  for (const s of sessions) {
    const w = (s.windows ?? []).find((x) => x.id === windowId);
    if (w) return { windowId, sessionName: s.name, windowIndex: w.index, cwd: expandHome(w.cwd || s.path), command: w.command };
  }
  return null;
}

async function readUsage() {
  const empty = { available: false, fiveHour: null, sevenDay: null };
  let state;
  try {
    state = JSON.parse(await fs.readFile(RATE_LIMIT_STATE_PATH, "utf8"));
  } catch {
    return empty;
  }
  const updatedAt = Number(state.updated_at) * 1000;
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt > RATE_LIMIT_STALE_MS) return empty;
  const toWindow = (pct, resetsAt) =>
    Number.isFinite(Number(pct))
      ? { utilization: Number(pct), resetsAt: Number.isFinite(Number(resetsAt)) ? new Date(Number(resetsAt) * 1000).toISOString() : null }
      : null;
  const fiveHour = toWindow(state.five_hour_pct, state.resets_at);
  const sevenDay = toWindow(state.seven_day_pct, state.seven_day_resets_at);
  return fiveHour || sevenDay ? { available: true, fiveHour, sevenDay } : empty;
}

export function activate({ router, log, getSettings, host }) {
  watcher?.stop();
  const canRead = typeof host?.sessions?.capture === "function";
  if (!canRead) log?.("claude-viewer: this Perch has no host.sessions.capture; prompts and mode are unavailable");
  watcher = canRead ? createWatcher({ host, log, getSettings }) : null;

  const send = (windowId, bytes, submit = false) => host.sessions.sendTextToWindow(windowId, bytes, submit);

  // What this Perch supports, and which foreground commands are Claude Code
  // (what decides where the open icon shows).
  router.get("/capabilities", async (_req, res) => {
    let agents = null;
    try {
      agents = (await host.agents?.list()) ?? null;
    } catch {
      // No registry: "claude" alone.
    }
    res.json({
      screen: canRead,
      notifications: typeof host?.notifications?.push === "function",
      programs: [...claudePrograms(agents)],
    });
  });

  // Every Claude window the watcher knows, with whether it waits on a prompt:
  // what the window-row icon shows.
  router.get("/windows", (_req, res) => {
    const list = watcher?.list() ?? [];
    res.json({
      windows: list.map((w) => ({
        windowId: w.windowId,
        sessionName: w.sessionName,
        windowIndex: w.windowIndex,
        waiting: Boolean(w.prompt),
        unmodeled: Boolean(w.unmodeled),
        mode: w.mode?.id ?? null,
      })),
    });
  });

  // A window's stable id from what a window action is handed.
  router.get("/window-id", async (req, res) => {
    const session = str(req.query.session);
    const index = Number(req.query.index);
    if (!session || !Number.isInteger(index)) {
      res.status(400).json({ error: "session and index are required" });
      return;
    }
    try {
      const panes = await host.sessions.listPanes(session);
      const pane = panes.find((p) => p.windowIndex === index);
      if (!pane) {
        res.status(404).json({ error: "window not found" });
        return;
      }
      res.json({ windowId: pane.id, title: pane.title, command: pane.command });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  router.get("/session", async (req, res) => {
    const windowId = str(req.query.windowId);
    if (!windowId) {
      res.status(400).json({ error: "windowId is required" });
      return;
    }
    const info = await windowInfo(host, windowId);
    const session = await sessionForWindow(windowId, info ? expandHome(info.cwd) : null);
    // Running means Claude is still the window's foreground command: the
    // watcher only tracks those windows.
    const running = watcher ? Boolean(watcher.get(windowId) ?? (await watcher.refresh(windowId))) : info?.command === "claude";
    res.json({
      window: info ? { windowId, sessionName: info.sessionName, windowIndex: info.windowIndex, cwd: expandHome(info.cwd) } : null,
      running,
      session,
    });
  });

  router.get("/transcript", async (req, res) => {
    const sessionId = str(req.query.sessionId);
    if (!/^[\w-]+$/.test(sessionId)) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }
    const file = await findSessionFile(sessionId, expandHome(str(req.query.cwd)) || null);
    if (!file) {
      res.status(404).json({ error: "transcript not found" });
      return;
    }
    let cursor = null;
    try {
      cursor = req.query.cursor ? JSON.parse(str(req.query.cursor)) : null;
    } catch {
      cursor = null;
    }
    const { messages, cursor: next } = await readTranscript(file, cursor);
    res.json({ messages, cursor: JSON.stringify(next) });
  });

  router.get("/screen", async (req, res) => {
    const windowId = str(req.query.windowId);
    if (!watcher) {
      res.json({ windowId, unsupported: true });
      return;
    }
    const state = watcher.get(windowId) ?? (await watcher.refresh(windowId));
    res.json(state ?? { windowId, closed: true, epoch: 0 });
  });

  // Long poll: answers as soon as the window's epoch passes the one given, or
  // after about 25 seconds with the unchanged state.
  router.get("/wait", async (req, res) => {
    const windowId = str(req.query.windowId);
    if (!watcher) {
      res.json({ windowId, unsupported: true });
      return;
    }
    const epoch = Number(req.query.epoch) || 0;
    let aborted = false;
    req.on("close", () => {
      aborted = true;
    });
    const state = await watcher.wait(windowId, epoch);
    if (!aborted) res.json(state ?? { windowId, closed: true, epoch: epoch + 1 });
  });

  // Answer a prompt or press a key.
  //   { windowId, action: { type: "option", n }, expect: { signature } }
  //   { windowId, action: { type: "key", key }, expect?: { signature } }
  //   { windowId, action: { type: "option-key", n, key }, expect: { signature } }
  //   { windowId, action: { type: "action" }, expect: { signature } }
  //     presses a multi-select list's Next or Submit button
  //   { windowId, action: { type: "cursor", n }, expect: { signature } }
  //     moves the highlight to option n without choosing it (a preview
  //     prompt shows the highlighted option's preview)
  //   { windowId, action: { type: "chat" }, expect: { signature } }
  //     chooses a preview prompt's unnumbered "Chat about this"
  //   { windowId, action: { type: "notes", text }, expect: { signature } }
  //     sets a preview prompt's notes
  //     moves the cursor to option n, then presses a letter the footer offers
  //     for the highlighted row (/model's "s to use this session only")
  // An option is only chosen while a fresh read still shows the prompt with
  // that signature; otherwise 409 and nothing is sent.
  router.post("/key", async (req, res) => {
    const windowId = str(req.body?.windowId);
    const action = req.body?.action ?? {};
    const expected = str(req.body?.expect?.signature);
    if (!watcher || !windowId) {
      res.status(400).json({ error: "windowId is required" });
      return;
    }
    let state = await watcher.refresh(windowId);
    if (!state) {
      res.status(404).json({ error: "window not found" });
      return;
    }
    if (expected && state.prompt?.signature !== expected) {
      res.status(409).json({ error: "The terminal moved on", state });
      return;
    }
    if (action.type === "key") {
      if (!isKeyName(action.key)) {
        res.status(400).json({ error: "unknown key" });
        return;
      }
      await send(windowId, KEYS[action.key]);
    } else if (action.type === "option") {
      const n = Number(action.n);
      if (!state.prompt) {
        res.status(409).json({ error: "No prompt on screen", state });
        return;
      }
      // One key at a time, re-reading between, until the option is chosen: a
      // digit or Enter, or "here" for a text field the cursor already sits
      // in. Arrows first when the cursor is in a text field (a digit would be
      // typed) or the list is unnumbered.
      let done = false;
      for (let step = 0; step < MAX_NAV_STEPS && !done; step++) {
        if (expected && state.prompt?.signature !== expected) break;
        const key = state.prompt ? nextKeyForOption(state.prompt, n) : null;
        if (!key) break;
        if (key === "here") {
          done = true;
          break;
        }
        await send(windowId, KEYS[key]);
        if (key === "enter" || /^[1-9]$/.test(key)) done = true;
        await sleep(AFTER_KEY_MS);
        state = await watcher.refresh(windowId);
        if (!state) break;
      }
      if (!done) {
        res.status(409).json({ error: "Could not reach that option", state });
        return;
      }
      res.json({ ok: true, state });
      return;
    } else if (action.type === "cursor" || action.type === "chat") {
      const n = Number(action.n);
      let done = false;
      for (let step = 0; step < MAX_NAV_STEPS && state?.prompt; step++) {
        if (expected && state.prompt.signature !== expected) break;
        const key = action.type === "chat" ? nextKeyForChat(state.prompt) : cursorStepToward(state.prompt, n);
        if (!key) break;
        if (key === "here") {
          done = true;
          break;
        }
        await send(windowId, KEYS[key]);
        if (key === "enter") {
          done = true;
          break;
        }
        await sleep(AFTER_KEY_MS);
        state = await watcher.refresh(windowId);
      }
      if (!done) {
        res.status(409).json({ error: action.type === "chat" ? "Could not reach Chat about this" : "Could not reach that option", state });
        return;
      }
    } else if (action.type === "notes") {
      // n opens the Notes field; what is there is replaced (Ctrl+E to its end,
      // then a Backspace per character), and Esc closes it, keeping the text.
      const text = str(action.text).replace(/[\r\n]+/g, " ");
      for (let step = 0; step < 3 && state?.prompt?.notes && !state.prompt.notes.editing; step++) {
        await send(windowId, "n");
        await sleep(AFTER_KEY_MS);
        state = await watcher.refresh(windowId);
      }
      const notes = state?.prompt?.notes;
      if (!notes?.editing) {
        res.status(409).json({ error: "Could not open the notes", state });
        return;
      }
      if (notes.text) await send(windowId, KEYS.ctrlE + KEYS.backspace.repeat([...notes.text].length));
      if (text) {
        await send(windowId, bracketedPaste(text));
        await sleep(SETTLE_MS);
      }
      await send(windowId, KEYS.esc);
    } else if (action.type === "action") {
      // A multi-select list's Next or Submit button: Tab reaches it, Enter
      // presses it. Done early if the prompt moves on (Tab can switch to the
      // next question).
      let done = false;
      for (let step = 0; step < 4 && state?.prompt?.action; step++) {
        if (expected && state.prompt.signature !== expected) break;
        if (state.prompt.action.cursor) {
          await send(windowId, KEYS.enter);
          done = true;
          break;
        }
        await send(windowId, KEYS.tab);
        await sleep(AFTER_KEY_MS);
        state = await watcher.refresh(windowId);
      }
      if (!done) {
        res.status(409).json({ error: "Could not reach that button", state });
        return;
      }
    } else if (action.type === "option-key") {
      const n = Number(action.n);
      const prompt = state.prompt;
      const letter = prompt ? letterKeyFor(prompt, action.key) : null;
      const target = prompt?.options.find((o) => o.n === n);
      if (!prompt || !letter || !target) {
        res.status(400).json({ error: "that key isn't offered for this option" });
        return;
      }
      // Arrows can scroll a long list, which changes the visible rows and so
      // the signature. Between steps, the target row itself is what must
      // still be there, with the same label.
      let reached = false;
      for (let step = 0; step < MAX_NAV_STEPS; step++) {
        const row = state?.prompt?.options.find((o) => o.n === n);
        if (!row || row.label !== target.label) break;
        const move = cursorStepToward(state.prompt, n);
        if (move === "here") {
          reached = true;
          break;
        }
        if (!move) break;
        await send(windowId, KEYS[move]);
        await sleep(AFTER_KEY_MS);
        state = await watcher.refresh(windowId);
      }
      if (!reached) {
        res.status(409).json({ error: "Could not reach that option", state });
        return;
      }
      await send(windowId, letter);
    } else {
      res.status(400).json({ error: "unknown action" });
      return;
    }
    await sleep(AFTER_KEY_MS);
    res.json({ ok: true, state: await watcher.refresh(windowId) });
  });

  // Text into whatever is focused in the TUI, then Enter: a message in the
  // input box, or the text field a "Type something" / "Tell Claude what to
  // change" option opens.
  router.post("/send", async (req, res) => {
    const windowId = str(req.body?.windowId);
    const text = str(req.body?.text);
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.filter((p) => typeof p === "string" && p) : [];
    if (!windowId) {
      res.status(400).json({ error: "windowId is required" });
      return;
    }
    const info = await windowInfo(host, windowId);
    if (!info) {
      res.status(404).json({ error: "window not found" });
      return;
    }
    const full = [text, ...paths].filter(Boolean).join(" ").trim();
    if (!full) {
      res.status(400).json({ error: "nothing to send" });
      return;
    }
    // An answer for a prompt's text field ("Type something", "Tell Claude
    // what to change"): put the cursor in the field and clear what is already
    // typed there, so the answer lands in it and replaces rather than appends.
    if (watcher && req.body?.clearInput === false) {
      let state = await watcher.refresh(windowId);
      const entryOf = (s) => s?.prompt?.options.find((o) => o.textEntry) ?? null;
      const entry = entryOf(state);
      if (entry) {
        let reached = false;
        for (let step = 0; step < MAX_NAV_STEPS && state?.prompt; step++) {
          const key = nextKeyForOption(state.prompt, entry.n);
          if (key === "here") {
            reached = true;
            break;
          }
          if (!key) break;
          await send(windowId, KEYS[key]);
          await sleep(AFTER_KEY_MS);
          state = await watcher.refresh(windowId);
        }
        if (!reached) {
          res.status(409).json({ error: "Could not reach the text field", state });
          return;
        }
        const typed = entryOf(state)?.typed ?? "";
        if (typed) {
          // Arrowing into the field leaves its caret at the start: Ctrl+E to
          // the end, then one Backspace per character.
          await send(windowId, KEYS.ctrlE + KEYS.backspace.repeat([...typed].length));
          await sleep(AFTER_KEY_MS);
        }
      }
    }
    // Whatever already sits in the terminal's input box (a draft typed there,
    // or the prompt Claude Code puts back after an interrupt) would be sent
    // together with this message. Clear it first: Ctrl+U deletes one line per
    // press. Text that doesn't change under Ctrl+U is Claude's own suggestion
    // placeholder, which typing replaces anyway. The tab shows the box's text
    // above the composer, so a draft can be pulled into the message first.
    if (watcher && req.body?.clearInput !== false) {
      let state = await watcher.refresh(windowId);
      // A message typed while a prompt is up would land in the prompt: Enter
      // picks its highlighted option. Only the prompt card's own text field
      // (clearInput false) types into a prompt.
      if (state?.prompt) {
        res.status(409).json({ error: "Answer the prompt first. The message was not sent.", state });
        return;
      }
      let last = state?.input?.text ?? "";
      let unchanged = 0;
      for (let i = 0; i < 40 && last && unchanged < 2 && !state?.prompt; i++) {
        await send(windowId, KEYS.ctrlU);
        await sleep(60);
        state = await watcher.refresh(windowId);
        const now = state?.input?.text ?? "";
        unchanged = now === last ? unchanged + 1 : 0;
        last = now;
      }
    }
    await send(windowId, bracketedPaste(full));
    await sleep(SETTLE_MS);
    // A multi-select text field takes the text without Enter, which would
    // untick the row the typing just ticked.
    if (req.body?.submit !== false) await send(windowId, KEYS.enter);
    await sleep(AFTER_KEY_MS);
    res.json({ ok: true, state: watcher ? await watcher.refresh(windowId) : null });
  });

  router.post("/stop", async (req, res) => {
    const windowId = str(req.body?.windowId);
    if (!windowId) {
      res.status(400).json({ error: "windowId is required" });
      return;
    }
    await send(windowId, KEYS.esc);
    watcher?.interrupted(windowId);
    await sleep(AFTER_KEY_MS);
    watcher?.interrupted(windowId);
    res.json({ ok: true, state: watcher ? await watcher.refresh(windowId) : null });
  });

  router.post("/cycle-mode", async (req, res) => {
    const windowId = str(req.body?.windowId);
    if (!windowId) {
      res.status(400).json({ error: "windowId is required" });
      return;
    }
    const before = watcher?.get(windowId)?.mode?.id ?? null;
    await send(windowId, KEYS.shiftTab);
    let state = null;
    for (let i = 0; i < 6 && watcher; i++) {
      await sleep(AFTER_KEY_MS);
      state = await watcher.refresh(windowId);
      if (state?.mode?.id && state.mode.id !== before) break;
    }
    res.json({ ok: true, state });
  });

  router.get("/commands", async (req, res) => {
    const info = await windowInfo(host, str(req.query.windowId));
    res.json({ commands: await listCommands(info ? expandHome(info.cwd) : "") });
  });

  router.get("/files", async (req, res) => {
    const info = await windowInfo(host, str(req.query.windowId));
    if (!info) {
      res.json({ files: [] });
      return;
    }
    res.json({ files: await searchProjectFiles(expandHome(info.cwd), str(req.query.q)) });
  });

  // Which of the path-shaped strings the tab found in the conversation are
  // real files, resolved against the session's cwd (sent by the tab, which
  // knows it from /session) or else the window's: what makes them links.
  router.post("/resolve-paths", async (req, res) => {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths.slice(0, MAX_PATHS) : [];
    let cwd = expandHome(str(req.body?.cwd));
    if (!cwd) {
      const info = await windowInfo(host, str(req.body?.windowId));
      cwd = info ? expandHome(info.cwd) : "";
    }
    res.json({ results: await resolvePaths(paths, cwd) });
  });

  router.get("/usage", async (_req, res) => {
    res.json(await readUsage());
  });

  log?.("claude-viewer server hook active");
}

export function deactivate() {
  watcher?.stop();
  watcher = null;
}
