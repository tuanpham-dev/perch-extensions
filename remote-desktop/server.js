// Server hook for the Remote Desktop extension: runs quicdesk-server inside
// its own terminal session, so the streaming port is owned by a terminal's
// process tree; the core proxy only forwards ports it can attribute to a
// terminal (server/src/ports.ts's getTunnelablePorts), and a plain detached
// child here would get a 403 from /proxy/<port>/. In managed mode the server
// itself starts the X server and the desktop session (--spawn-display,
// --desktop) and
// takes them down when it exits, however it exits, so stopping the session
// is all the cleanup there is. The session is created, typed into and killed
// through the host session API, so this works on whichever terminal backend
// runs it. Ground truth for "running" is what answers on the port, never an
// in-memory flag.
import { execFile } from "node:child_process";
import { access, chmod, constants as fsConstants } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SESSION_NAME = "remote-desktop";
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const START_TIMEOUT_MS = 15000;
const START_POLL_INTERVAL_MS = 250;
// The server tears its Xvfb and desktop down before it exits, which frees
// the port; Stop waits for that so the next Start finds the display free.
const STOP_TIMEOUT_MS = 5000;
const STATUS_TIMEOUT_MS = 800;
const BIN_CHECK_TIMEOUT_MS = 5000;
const MAX_PORT_SCAN = 200;
const MAX_COMMAND_LENGTH = 500;
const INITIAL_SIZE = "1920x1080";
// The largest display a tab may ask for (8K); the server tiles anything
// above one encoder's 4096x2304.
const XVFB_FRAMEBUFFER = "7680x4320x24";
// Applied when a setting is missing from the settings document (a fresh
// install before the Settings UI ever wrote it).
const DEFAULTS = {
  mode: "managed",
  display: ":101",
  desktopCommand: "xfce4-session",
  keyboardLayout: "us",
  xServer: "auto",
  port: 14600,
  fps: 30,
  bitrateKbps: 8000,
  dpi: 96,
  serverPath: "",
};

// Environment for a toolkit started at the desktop's current scale: GTK
// takes an integer window scale plus a fractional font scale, Qt one factor.
function scaleEnvironment(scale) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const gdkScale = s >= 2 ? 2 : 1;
  return [
    ["GDK_SCALE", String(gdkScale)],
    ["GDK_DPI_SCALE", (s / gdkScale).toFixed(3)],
    ["QT_SCALE_FACTOR", s.toFixed(3)],
    ["QT_ENABLE_HIGHDPI_SCALING", "0"],
  ];
}

function shellQuote(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: "utf8", timeout: BIN_CHECK_TIMEOUT_MS, ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(stderr.trim() || err.message), { code: err.code }));
      else resolve(stdout);
    });
  });
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

// The server's own status line: null when nothing answers there.
async function probeStatus(port) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: ctl.signal });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.viewers === "number" ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForStatus(port, totalMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const status = await probeStatus(port);
    if (status) return status;
    await new Promise((r) => setTimeout(r, START_POLL_INTERVAL_MS));
  }
  return null;
}

// True once nothing answers on the port any more.
async function waitForSilence(port, totalMs = STOP_TIMEOUT_MS) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (!(await probeStatus(port))) return true;
    await new Promise((r) => setTimeout(r, START_POLL_INTERVAL_MS));
  }
  return false;
}

function readSettings(raw) {
  const get = (key, fallback) => {
    const v = raw[`remoteDesktop.${key}`];
    return v === undefined || v === null || v === "" ? fallback : v;
  };
  const mode = get("mode", DEFAULTS.mode) === "existing" ? "existing" : "managed";
  return {
    mode,
    display: String(get("display", DEFAULTS.display)).trim() || DEFAULTS.display,
    desktopCommand: String(get("desktopCommand", DEFAULTS.desktopCommand)),
    keyboardLayout: String(get("keyboardLayout", DEFAULTS.keyboardLayout)),
    xServer: ["auto", "xvfb", "xwayland"].includes(get("xServer", DEFAULTS.xServer))
      ? get("xServer", DEFAULTS.xServer)
      : DEFAULTS.xServer,
    port: Number(get("port", DEFAULTS.port)) || DEFAULTS.port,
    fps: Number(get("fps", DEFAULTS.fps)) || DEFAULTS.fps,
    bitrateKbps: Number(get("bitrateKbps", DEFAULTS.bitrateKbps)) || DEFAULTS.bitrateKbps,
    dpi: Number(get("dpi", DEFAULTS.dpi)) || DEFAULTS.dpi,
    serverPath: String(raw["remoteDesktop.serverPath"] ?? "").trim(),
  };
}

// The server binary shipped in this package for the host's architecture,
// or null on a platform without one (only Linux x64 and arm64 ship).
async function bundledBinary() {
  const arch = { x64: "x64", arm64: "arm64" }[process.arch];
  if (process.platform !== "linux" || !arch) return null;
  const file = path.join(EXTENSION_DIR, "bin", `quicdesk-server-linux-${arch}`);
  try {
    await access(file, fsConstants.R_OK);
  } catch {
    return null;
  }
  // Perch's installer writes files without their mode bits, so the binary
  // arrives non-executable; restore that before the first run.
  try {
    await access(file, fsConstants.X_OK);
  } catch {
    await chmod(file, 0o755);
  }
  return file;
}

// Where quicdesk-server is: the setting, then the binary shipped with this
// extension, then PATH, then cargo's bin dir (the host's PATH often lacks it
// when Perch runs as a service). Cached per candidate list, since the binary
// set only changes with a reinstall.
let binaryCache = { key: null, result: null };
async function findServerBinary(serverPath) {
  const bundled = serverPath ? null : await bundledBinary();
  const candidates = serverPath
    ? [serverPath]
    : [bundled, "quicdesk-server", path.join(os.homedir(), ".cargo", "bin", "quicdesk-server")].filter(Boolean);
  const key = candidates.join("\n");
  if (binaryCache.key === key && binaryCache.result?.installed) return binaryCache.result;
  for (const candidate of candidates) {
    try {
      const help = await run(candidate, ["--help"]);
      if (!help.includes("--spawn-display")) {
        binaryCache = { key, result: { installed: false, path: candidate, reason: "outdated" } };
        return binaryCache.result;
      }
      binaryCache = { key, result: { installed: true, path: candidate } };
      return binaryCache.result;
    } catch {
      // try the next one
    }
  }
  binaryCache = { key, result: { installed: false, path: candidates[0], reason: "missing" } };
  return binaryCache.result;
}

const NOT_RUNNING = { running: false, port: null, viewers: 0, width: 0, height: 0, scale: 1 };

export function activate({ router, log, getSettings, host }) {
  // Only carries the port picked by the last /start across requests; the
  // port list from core is the primary source and survives a reload.
  let lastPort = null;

  async function findSession() {
    const sessions = await host.sessions.list();
    return sessions.find((s) => s.name === SESSION_NAME) ?? null;
  }

  async function getRunningInfo() {
    if (!(await findSession())) return NOT_RUNNING;
    const owned = (await host.ports.list()).filter((p) => p.session === SESSION_NAME).map((p) => p.port);
    // The port this instance started is asked first, then the configured
    // one: another Perch instance on the same host may run a session of
    // the same name (the process table is shared), and its port must not
    // be mistaken for ours.
    const settings = readSettings(await getSettings());
    const candidates = [...new Set([lastPort, settings.port, ...owned].filter((p) => typeof p === "number" && p > 0))];
    for (const port of candidates) {
      const status = await probeStatus(port);
      if (status) {
        return {
          running: true,
          port,
          viewers: status.viewers,
          width: status.width,
          height: status.height,
          scale: typeof status.scale === "number" ? status.scale : 1,
        };
      }
    }
    return NOT_RUNNING;
  }

  // Killing the session hangs up the server's terminal; the server takes
  // its Xvfb and desktop down on that and exits, which closes the port.
  async function stopEverything() {
    const { port } = await getRunningInfo();
    await host.sessions.kill(SESSION_NAME).catch(() => {});
    if (port && !(await waitForSilence(port))) {
      log(`quicdesk-server on ${port} did not exit after its session was killed`);
    }
    lastPort = null;
  }

  router.get("/status", async (_req, res) => {
    try {
      const settings = readSettings(await getSettings());
      const [binary, running] = await Promise.all([findServerBinary(settings.serverPath), getRunningInfo()]);
      res.json({
        installed: binary.installed,
        serverPath: binary.path,
        serverReason: binary.reason ?? null,
        mode: settings.mode,
        display: settings.display,
        desktopCommand: settings.desktopCommand,
        ...running,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/start", async (_req, res) => {
    try {
      const settings = readSettings(await getSettings());
      const binary = await findServerBinary(settings.serverPath);
      if (!binary.installed) {
        res.status(400).json({
          error:
            binary.reason === "outdated"
              ? `${binary.path} is too old (no --spawn-display); rebuild it from the QuicDesk repository.`
              : "quicdesk-server was not found. Install it (see this extension's README) or set its path in Settings.",
        });
        return;
      }
      if ((await getRunningInfo()).running) {
        res.status(409).json({ error: "Remote Desktop is already running." });
        return;
      }
      if (await findSession()) {
        // A leftover session with nothing listening: start clean.
        await stopEverything();
      }
      const port = await pickPort(settings.port);
      const args = [
        "--display", settings.display,
        "--listen", "127.0.0.1:0",
        "--ws-listen", `127.0.0.1:${port}`,
        "--fps", String(settings.fps),
        "--bitrate", String(settings.bitrateKbps * 1000),
      ];
      if (settings.mode === "managed") {
        // The server owns the X server and the desktop: it starts them,
        // resizes the display to the tab, and ends them with itself. The
        // scale hook gets the desktop's session bus from the server.
        args.push(
          "--spawn-display",
          "--x-server", settings.xServer,
          "--xvfb-screen", XVFB_FRAMEBUFFER,
          "--dpi", String(settings.dpi),
          "--keyboard-layout", settings.keyboardLayout,
          "--desktop", settings.desktopCommand,
          "--initial-size", INITIAL_SIZE,
          "--on-scale", `bash ${shellQuote(path.join(EXTENSION_DIR, "apply-scale.sh"))}`,
        );
      }
      await host.sessions.create(SESSION_NAME, os.homedir(), true);
      // `exec` makes the server the window's own process, so the window
      // (and with it the single-window session) ends when it does, and
      // killing the window hangs the server up.
      const line = ["exec", shellQuote(binary.path), ...args.map(shellQuote)].join(" ");
      await host.sessions.sendText(SESSION_NAME, line, true);
      lastPort = port;

      const status = await waitForStatus(port);
      if (!status) {
        await stopEverything();
        log(`quicdesk-server did not answer on ${port} in time; its output is in the ${SESSION_NAME} session`);
        res.status(502).json({
          error: `Remote Desktop did not start in time; open the ${SESSION_NAME} session to read its output.`,
        });
        return;
      }
      res.json({
        installed: true,
        serverPath: binary.path,
        mode: settings.mode,
        display: settings.display,
        running: true,
        port,
        viewers: status.viewers,
        width: status.width,
        height: status.height,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/stop", async (_req, res) => {
    try {
      await stopEverything();
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
      const settings = readSettings(await getSettings());
      if (settings.mode !== "managed") {
        res.status(400).json({ error: "Launch is only available for a managed display." });
        return;
      }
      const info = await getRunningInfo();
      if (!info.running) {
        res.status(400).json({ error: "Start Remote Desktop first." });
        return;
      }
      // A new window of the session, with the command typed at its shell
      // prompt as the user wrote it. DISPLAY rides along on the same line,
      // and so does the desktop scale for toolkits that only read it at
      // startup (Qt; GTK takes it from xsettings but the env is harmless).
      const index = await host.sessions.createWindow(SESSION_NAME, cwd);
      const scaleEnv = scaleEnvironment(info.scale)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(" ");
      await host.sessions.sendText(SESSION_NAME, `${scaleEnv} DISPLAY=${shellQuote(settings.display)} ${command}`, true, index);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
