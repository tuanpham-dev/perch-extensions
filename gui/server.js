// Server hook for the GUI Apps extension: runs xpra (an adaptive HTML5
// remote-display server) inside its own terminal session so its listening
// port is owned by a terminal's process tree — the core proxy only forwards
// to ports it can attribute to a terminal (see server/src/ports.ts's
// getTunnelablePorts), so a plain detached child process here would get a
// 403 from /proxy/<port>/. The session is created, typed into and killed
// through the host session API, so this works on whichever terminal backend
// runs it (the bundled daemon or the tmux backend); the only binary this file
// runs itself is `xpra`.
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";

const SESSION_NAME = "gui-apps";
const XPRA_TIMEOUT = 5000;
const PORT_PROBE_TIMEOUT = 500;
const START_TIMEOUT_MS = 10000;
const START_POLL_INTERVAL_MS = 250;
const MAX_PORT_SCAN = 200;
const MAX_COMMAND_LENGTH = 500;

// A short, fixed runtime dir rather than trusting $XDG_RUNTIME_DIR / its
// /tmp fallback — xpra's control socket path lives under it, and a long
// path (e.g. a deeply nested project dir some other tool set XDG_RUNTIME_DIR
// to) overflows AF_UNIX's ~108-char limit and fails to bind, observed live
// while developing this extension.
const RUNTIME_DIR = `/tmp/perch-gui-${process.getuid()}`;

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: "utf8", timeout: XPRA_TIMEOUT, ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(stderr.trim() || err.message), { code: err.code }));
      else resolve(stdout);
    });
  });
}

// Single-quotes one word for the session's shell, so the xpra line typed into
// it survives spaces and shell metacharacters in any argument.
function shellQuote(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

function checkPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickPort(preferred) {
  let port = preferred;
  for (let i = 0; i < MAX_PORT_SCAN; i++) {
    if (await checkPortFree(port)) return port;
    port++;
  }
  throw new Error(`no free port found starting from ${preferred}`);
}

function probePort(port, timeoutMs = PORT_PROBE_TIMEOUT) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => resolve(false));
  });
}

async function waitForPort(port, totalMs = START_TIMEOUT_MS, intervalMs = START_POLL_INTERVAL_MS) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function isXpraInstalled() {
  try {
    await run("xpra", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

// xpra's own picture-codec self-report (a static probe of installed codec
// modules — doesn't require a running session). Cached for the server's
// lifetime: the installed module set can't change without a reinstall.
let encodingsCache = null;
async function getEncodings() {
  if (encodingsCache) return encodingsCache;
  let out = "";
  try {
    out = await run("xpra", ["encoding"]);
  } catch (err) {
    // `xpra encoding` still exits non-zero after printing the full report
    // (it doubles as a self-test) — the stdout capture on the thrown error
    // is what we actually want here.
    out = err.stdout ?? "";
  }
  const wanted = { jpeg: "enc_jpeg", webp: "enc_webp", vpx: "enc_vpx", x264: "enc_x264" };
  const found = {};
  for (const [name, key] of Object.entries(wanted)) {
    const m = out.match(new RegExp(`\\*\\s*${key}\\s*:\\s*(.+)`));
    found[name] = !!m && !m[1].includes("No module named");
  }
  encodingsCache = found;
  return found;
}

const NOT_RUNNING = { running: false, port: null, display: null, mode: null };

export function activate({ router, log, getSettings, host }) {
  // What /start last launched. The port is re-derived from what is actually
  // listening (below), so this only carries the display and mode across
  // requests; after a server reload it is empty and the settings stand in.
  let state = null;

  async function findGuiSession() {
    const sessions = await host.sessions.list();
    return sessions.find((s) => s.name === SESSION_NAME) ?? null;
  }

  // Ground truth is what is listening, not an in-memory variable: the
  // session must exist, and one of the ports core attributes to it must
  // answer. That survives a server.js reload picking up a session created by
  // an earlier run, and never drifts from what is actually serving.
  async function getRunningInfo() {
    if (!(await findGuiSession())) return NOT_RUNNING;
    const owned = (await host.ports.list()).filter((p) => p.session === SESSION_NAME);
    const candidates = owned.map((p) => p.port);
    if (state?.port && !candidates.includes(state.port)) candidates.push(state.port);
    for (const port of candidates) {
      if (await probePort(port)) {
        const settings = await getSettings();
        const display = state?.display ?? (typeof settings["gui.display"] === "string" ? settings["gui.display"] : ":100");
        const mode = state?.mode ?? (settings["gui.mode"] === "desktop" ? "desktop" : "seamless");
        return { running: true, port, display, mode };
      }
    }
    return NOT_RUNNING;
  }

  function qualityArgs(quality) {
    if (quality === "high") return ["--min-quality=70"];
    if (quality === "low") return ["--min-speed=70"];
    return [];
  }

  // xpra treats a runtime dir it doesn't own with exactly 0700 permissions as
  // possibly-unsafe and falls into a slow "socket probing" wait before it'll
  // bind — observed live to blow well past an 8s start budget. Recreating the
  // dir fresh with the right mode every time avoids that path entirely rather
  // than trying to out-wait it.
  async function ensureRuntimeDir() {
    await rm(RUNTIME_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  }

  // Shared by /stop and /start's timeout-failure path — `xpra stop` tears down
  // its Xvfb child cleanly; killing the session alone was observed to leave it
  // orphaned.
  async function stopEverything(display) {
    if (display) {
      await run("xpra", ["stop", display], {
        env: { ...process.env, XDG_RUNTIME_DIR: RUNTIME_DIR },
      }).catch(() => {});
    }
    await host.sessions.kill(SESSION_NAME).catch(() => {});
    state = null;
  }

  router.get("/status", async (_req, res) => {
    try {
      const [installed, running, encodings] = await Promise.all([
        isXpraInstalled(),
        getRunningInfo(),
        getEncodings(),
      ]);
      res.json({ installed, ...running, encodings });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/start", async (_req, res) => {
    try {
      if (!(await isXpraInstalled())) {
        res.status(400).json({
          error: "xpra is not installed on this host — see this extension's README for install instructions.",
        });
        return;
      }
      const already = await getRunningInfo();
      if (already.running) {
        res.json({ ...already, encodings: await getEncodings() });
        return;
      }
      const settings = await getSettings();
      const display = typeof settings["gui.display"] === "string" ? settings["gui.display"] : ":100";
      const preferredPort = Number.isFinite(settings["gui.port"]) ? settings["gui.port"] : 14500;
      const quality = typeof settings["gui.quality"] === "string" ? settings["gui.quality"] : "auto";
      const dpi = Number.isFinite(settings["gui.dpi"]) ? settings["gui.dpi"] : 96;
      const mode = settings["gui.mode"] === "desktop" ? "desktop" : "seamless";
      const desktopCommand =
        typeof settings["gui.desktopCommand"] === "string" && settings["gui.desktopCommand"].trim()
          ? settings["gui.desktopCommand"].trim()
          : "xfce4-session";
      const resizeDisplay = settings["gui.resizeDisplay"] === "fixed" ? "no" : "yes";
      const port = await pickPort(preferredPort);

      // Any leftover session (e.g. one whose xpra process died without
      // cleanly tearing down the session side) is cleared before relaunching.
      await host.sessions.kill(SESSION_NAME).catch(() => {});
      await ensureRuntimeDir();

      const xpraArgs = [
        // Seamless mode composites individual app windows (xpra is their
        // window manager); desktop mode streams one whole X11 screen with
        // its own window manager running inside it (xfwm4, in the default
        // xfce4-session) — the two window managers fight over the same
        // windows if seamless mode is used to launch a full desktop
        // environment, so this has to be a genuinely different subcommand,
        // not just a flag.
        mode === "desktop" ? "start-desktop" : "start",
        display,
        `--bind-tcp=127.0.0.1:${port}`,
        "--html=on",
        "--daemon=no",
        "--exit-with-children=no",
        "--mdns=no",
        "--notifications=no",
        "--pulseaudio=no",
        // REVERTED (do not re-add without fixing the underlying xpra bug
        // first): `--cursors=no` was tried here to stop the native-vs-remote
        // cursor divergence (see README), but in desktop mode it crashes
        // xpra's own pointer handler on every single mouse move/click —
        // `_adjust_pointer` unconditionally calls `self.restore_cursor(proto)`,
        // a method that only exists when cursor forwarding is enabled,
        // throwing `AttributeError: 'XpraDesktopServer' object has no
        // attribute 'restore_cursor'` server-side on every pointer event.
        // The exception is swallowed (server keeps running), so the failure
        // mode is silent: mouse motion/clicks just stop reaching X11
        // entirely — confirmed live via the server's own pointer position
        // never leaving its startup default. A real bug in this xpra
        // version's desktop/base.py, not a config issue on our end — a
        // working cursor was never worth trading away working input for.
        `--dpi=${dpi}`,
        // "yes" (xpra's own default) resizes the server's virtual display to
        // match the browser viewport on every resize, including xpra's own
        // window-level Fullscreen toggle — but xpra recalculates DPI from
        // the reported physical monitor size on each resize, which can
        // drift far from --dpi above and balloon the cursor/UI at some
        // sizes (observed live). "no" keeps DPI stable at the cost of the
        // display not filling the window natively.
        `--resize-display=${resizeDisplay}`,
        ...qualityArgs(quality),
        ...(mode === "desktop" ? [`--start=${desktopCommand}`] : []),
      ];
      // One line typed into a fresh session's shell: `exec` makes xpra the
      // window's own process, so the window (and with it the single-window
      // session) ends when xpra does, and "not running" looks like exactly
      // that. DISPLAY is exported here so apps launched later inherit it.
      await host.sessions.create(SESSION_NAME, os.homedir(), true);
      const line = [
        "exec",
        "env",
        `XDG_RUNTIME_DIR=${shellQuote(RUNTIME_DIR)}`,
        `DISPLAY=${shellQuote(display)}`,
        "xpra",
        ...xpraArgs.map(shellQuote),
      ].join(" ");
      await host.sessions.sendText(SESSION_NAME, line, true);
      state = { port, display, mode };

      if (!(await waitForPort(port))) {
        await stopEverything(display);
        log(`xpra failed to start on ${display}:${port}; its output is in the ${SESSION_NAME} session`);
        res.status(502).json({
          error: `xpra did not start in time; open the ${SESSION_NAME} session to read its output.`,
        });
        return;
      }
      res.json({ installed: true, running: true, port, display, mode, encodings: await getEncodings() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/stop", async (_req, res) => {
    try {
      const info = await getRunningInfo();
      await stopEverything(info.display);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/launch", async (req, res) => {
    const command = typeof req.body?.command === "string" ? req.body.command.trim() : "";
    const cwd = typeof req.body?.cwd === "string" && req.body.cwd ? req.body.cwd : os.homedir();
    if (!command) {
      res.status(400).json({ error: "command is required" });
      return;
    }
    if (command.length > MAX_COMMAND_LENGTH) {
      res.status(400).json({ error: "command too long" });
      return;
    }
    try {
      const info = await getRunningInfo();
      if (!info.running) {
        res.status(400).json({ error: "Start the GUI session first." });
        return;
      }
      // A new window of the session, with the command typed at its shell
      // prompt as the user wrote it — normal flag/quoting support for
      // whatever they typed. DISPLAY rides along on the same line.
      const index = await host.sessions.createWindow(SESSION_NAME, cwd);
      await host.sessions.sendText(SESSION_NAME, `DISPLAY=${shellQuote(info.display)} ${command}`, true, index);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
