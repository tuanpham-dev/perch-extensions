// Server hook for the Remote Desktop extension: finds (or downloads)
// qr-host and runs it inside its own terminal session, so the streaming
// port is owned by a terminal's process tree; the core proxy only forwards
// ports it can attribute to a terminal (server/src/ports.ts's
// getTunnelablePorts), and a plain detached child here would get a 403
// from /proxy/<port>/. In managed mode the host itself starts the virtual
// display and the desktop session (--source vdisplay --desktop) and takes
// them down when it exits, however it exits, so stopping the session is
// all the cleanup there is. The session is created, typed into and killed
// through the host session API, so this works on whichever terminal
// backend runs it. Ground truth for "running" is what answers on the
// port's /status, never an in-memory flag.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, constants as fsConstants, mkdir, rename, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const SESSION_NAME = "remote-desktop";
const START_TIMEOUT_MS = 20000;
const START_POLL_INTERVAL_MS = 250;
// The host tears its virtual display down before it exits, which frees
// the port; Stop waits for that so the next Start finds everything free.
const STOP_TIMEOUT_MS = 5000;
const STATUS_TIMEOUT_MS = 800;
const BIN_CHECK_TIMEOUT_MS = 5000;
const MAX_PORT_SCAN = 200;
const MAX_COMMAND_LENGTH = 500;
const INITIAL_SIZE = "1920x1080";
// The oldest qr-host this extension's viewer speaks to (the WebSocket
// gateway, seats and cursor shapes arrived in 0.2.0).
const REQUIRED_VERSION = "0.2.0";
// The first qr-host that can run the managed desktop on the user's own
// config directory (--desktop-user-config).
const USER_CONFIG_VERSION = "0.2.1";
// Where releases come from; PERCH_REMOTE_DESKTOP_RELEASE_API points the
// download at another server (a test, a mirror).
const RELEASE_API =
  process.env.PERCH_REMOTE_DESKTOP_RELEASE_API || "https://api.github.com/repos/tuanpham-dev/quick-remote/releases/latest";
const DOWNLOAD_DIR = path.join(os.homedir(), ".local", "share", "perch-remote-desktop");
// The running host's log (truncated on each Start) and what it logs: the
// rate controller's decisions are kept, since "why is it slow" is the
// question this file answers.
const HOST_LOG = path.join(DOWNLOAD_DIR, "host.log");
const HOST_LOG_LEVEL = process.env.PERCH_REMOTE_DESKTOP_LOG || "info,qr_host::ratectl=debug,qr_host::input=debug";
const CONFIG_DIR = path.join(os.homedir(), ".config", "perch-remote-desktop");
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// Applied when a setting is missing from the settings document (a fresh
// install before the Settings UI ever wrote it).
const DEFAULTS = {
  mode: "managed",
  display: "",
  desktopCommand: "xfce4-session",
  useGlobalConfig: false,
  keyboardLayout: "us",
  renderer: "auto",
  port: 14600,
  fps: 60,
  bitrateKbps: 40000,
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

// The host's own status line: null when nothing answers there.
async function probeStatus(port) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: ctl.signal });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body.viewers === "number" ? body : null;
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
  const renderer = ["auto", "gpu", "software"].includes(get("renderer", DEFAULTS.renderer)) ? get("renderer", DEFAULTS.renderer) : DEFAULTS.renderer;
  return {
    mode,
    display: String(get("display", DEFAULTS.display)).trim(),
    desktopCommand: String(get("desktopCommand", DEFAULTS.desktopCommand)),
    useGlobalConfig: get("useGlobalConfig", DEFAULTS.useGlobalConfig) === true,
    keyboardLayout: String(get("keyboardLayout", DEFAULTS.keyboardLayout)),
    renderer,
    port: Number(get("port", DEFAULTS.port)) || DEFAULTS.port,
    fps: Number(get("fps", DEFAULTS.fps)) || DEFAULTS.fps,
    bitrateKbps: Number(get("bitrateKbps", DEFAULTS.bitrateKbps)) || DEFAULTS.bitrateKbps,
    dpi: Number(get("dpi", DEFAULTS.dpi)) || DEFAULTS.dpi,
    serverPath: String(raw["remoteDesktop.serverPath"] ?? "").trim(),
  };
}

// ---- The engine binary ----

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return m ? m.slice(1, 4).map(Number) : null;
}

function versionAtLeast(found, required) {
  for (let i = 0; i < 3; i++) {
    if (found[i] !== required[i]) return found[i] > required[i];
  }
  return true;
}

const downloadedBinary = () => path.join(DOWNLOAD_DIR, "qr-host");

// Where qr-host is: the setting, then the binary this extension
// downloaded, then PATH, then cargo's bin dir (the host's PATH often lacks
// it when Perch runs as a service). Cached per candidate list, since the
// binary set only changes with a download or reinstall.
let binaryCache = { key: null, result: null };
function forgetBinary() {
  binaryCache = { key: null, result: null };
}
async function findServerBinary(serverPath) {
  // A setting left over from the QuicDesk days points at quicdesk-server:
  // that program is not qr-host, so it is skipped (and reported) rather
  // than hiding a perfectly good download behind it.
  const defaults = [
    ["downloaded", downloadedBinary()],
    ["path", "qr-host"],
    ["cargo", path.join(os.homedir(), ".cargo", "bin", "qr-host")],
  ];
  const candidates = serverPath ? [["setting", serverPath], ...defaults] : defaults;
  const key = candidates.map((c) => c[1]).join("\n");
  if (binaryCache.key === key && binaryCache.result?.installed) return binaryCache.result;
  const required = parseVersion(REQUIRED_VERSION);
  let outdated = null;
  let settingIgnored = null;
  for (const [source, candidate] of candidates) {
    let out;
    try {
      out = await run(candidate, ["--version"]);
    } catch {
      continue; // try the next one
    }
    if (!/^qr-host\b/.test(out.trim())) {
      if (source === "setting") settingIgnored = candidate;
      continue;
    }
    if (source !== "setting" && settingIgnored === null && serverPath) settingIgnored = serverPath;
    const found = parseVersion(out);
    const version = found ? found.join(".") : null;
    if (found && versionAtLeast(found, required)) {
      binaryCache = { key, result: { installed: true, path: candidate, source, version, reason: null, settingIgnored } };
      return binaryCache.result;
    }
    outdated ??= { installed: false, path: candidate, source, version, reason: "outdated", settingIgnored };
  }
  binaryCache = {
    key,
    result: outdated ?? { installed: false, path: candidates[0][1], source: null, version: null, reason: "missing", settingIgnored },
  };
  return binaryCache.result;
}

// ---- Downloading a release ----

const ARCH_ASSET = { x64: "qr-host-linux-x64.tar.gz", arm64: "qr-host-linux-arm64.tar.gz" };

const download = { state: "idle", percent: 0, error: null, version: null };

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "perch-remote-desktop" } });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "perch-remote-desktop" } });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

// Fetches the latest release's asset for this machine, checks it against
// the release's SHA256SUMS, unpacks it, and leaves nothing half-written
// behind on failure.
async function downloadEngine(log) {
  const asset = process.platform === "linux" ? ARCH_ASSET[process.arch] : null;
  if (!asset) throw new Error(`no release build for ${process.platform} ${process.arch}; build qr-host yourself and set its path in Settings`);
  const release = await fetchJson(RELEASE_API);
  download.version = String(release.tag_name ?? "").replace(/^v/, "") || null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const file = assets.find((a) => a.name === asset);
  const sums = assets.find((a) => a.name === "SHA256SUMS");
  if (!file) throw new Error(`the latest release (${release.tag_name}) has no ${asset}`);
  if (!sums) throw new Error(`the latest release (${release.tag_name}) has no SHA256SUMS`);
  const expected = fetchText(sums.browser_download_url).then((text) => {
    const line = text.split("\n").find((l) => l.trim().endsWith(asset));
    const hash = line ? line.trim().split(/\s+/)[0] : null;
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`SHA256SUMS has no entry for ${asset}`);
    return hash.toLowerCase();
  });

  const tmpDir = path.join(DOWNLOAD_DIR, ".tmp");
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  const archive = path.join(tmpDir, asset);
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(file.browser_download_url, { signal: ctl.signal, headers: { "user-agent": "perch-remote-desktop" } });
      if (!res.ok || !res.body) throw new Error(`${file.browser_download_url}: ${res.status} ${res.statusText}`);
      const total = Number(res.headers.get("content-length")) || Number(file.size) || 0;
      const hash = createHash("sha256");
      let received = 0;
      const counting = new TransformStream({
        transform(chunk, controller) {
          hash.update(chunk);
          received += chunk.byteLength;
          if (total > 0) download.percent = Math.min(99, Math.floor((received / total) * 100));
          controller.enqueue(chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body.pipeThrough(counting)), createWriteStream(archive));
      const digest = hash.digest("hex");
      const want = await expected;
      if (digest !== want) throw new Error(`checksum mismatch for ${asset}: got ${digest.slice(0, 12)}…, release says ${want.slice(0, 12)}…`);
    } finally {
      clearTimeout(timer);
    }
    await run("tar", ["xzf", archive, "-C", tmpDir], { timeout: 60000 });
    const unpacked = path.join(tmpDir, "qr-host");
    await access(unpacked, fsConstants.R_OK);
    await chmod(unpacked, 0o755);
    await mkdir(DOWNLOAD_DIR, { recursive: true });
    await rename(unpacked, downloadedBinary());
    download.percent = 100;
    log(`downloaded qr-host ${download.version ?? ""} to ${downloadedBinary()}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Host packages managed mode needs and this machine lacks.
async function missingPackages(settings) {
  if (settings.mode !== "managed") return [];
  const want = ["sway", "Xwayland", "pipewire", "wireplumber"];
  const desktop = String(settings.desktopCommand).trim().split(/\s+/)[0];
  if (desktop) want.push(desktop);
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const missing = [];
  for (const name of want) {
    if (name.startsWith("/")) {
      if (!(await stat(name).catch(() => null))) missing.push(name);
      continue;
    }
    let found = false;
    for (const dir of dirs) {
      if (await stat(path.join(dir, name)).catch(() => null)) {
        found = true;
        break;
      }
    }
    if (!found) missing.push(name);
  }
  return missing;
}

const NOT_RUNNING = {
  running: false,
  port: null,
  viewers: 0,
  width: 0,
  height: 0,
  scale: 1,
  codec: null,
  encoder: null,
  hostRenderer: null,
  source: null,
  cursorInPicture: false,
  displayEnv: null,
};

function fromHostStatus(port, status) {
  const env = status.display && typeof status.display === "object" ? status.display : null;
  return {
    running: true,
    port,
    viewers: status.viewers,
    width: Number(status.width) || 0,
    height: Number(status.height) || 0,
    scale: typeof status.scale === "number" && status.scale > 0 ? status.scale : 1,
    codec: typeof status.codec === "string" ? status.codec : null,
    encoder: typeof status.encoder === "string" ? status.encoder : null,
    hostRenderer: status.renderer === "gpu" || status.renderer === "software" ? status.renderer : null,
    source: typeof status.source === "string" ? status.source : null,
    cursorInPicture: status.cursorInPicture === true,
    // Everything the host says an app on the managed display needs: the X
    // and Wayland displays, the display's own runtime directory and session
    // bus (sound, portals, xfconf), and the toolkit scale variables.
    displayEnv: env && typeof env === "object" ? Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) : null,
  };
}

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
      if (status) return fromHostStatus(port, status);
    }
    return NOT_RUNNING;
  }

  // Killing the session hangs up the host's terminal; the host takes its
  // virtual display and desktop down on that and exits, which closes the
  // port.
  async function stopEverything() {
    const { port } = await getRunningInfo();
    await host.sessions.kill(SESSION_NAME).catch(() => {});
    if (port && !(await waitForSilence(port))) {
      log(`qr-host on ${port} did not exit after its session was killed`);
    }
    lastPort = null;
  }

  async function statusBody(settings, binary, running) {
    return {
      installed: binary.installed,
      serverPath: binary.path,
      serverReason: binary.reason ?? null,
      engineVersion: binary.version ?? null,
      requiredVersion: REQUIRED_VERSION,
      engineSource: binary.source ?? null,
      settingIgnored: binary.settingIgnored ?? null,
      mode: settings.mode,
      display: settings.display,
      desktopCommand: settings.desktopCommand,
      renderer: settings.renderer,
      missing: await missingPackages(settings),
      download: { ...download },
      ...running,
    };
  }

  router.get("/status", async (_req, res) => {
    try {
      const settings = readSettings(await getSettings());
      const [binary, running] = await Promise.all([findServerBinary(settings.serverPath), getRunningInfo()]);
      res.json(await statusBody(settings, binary, running));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/download", async (_req, res) => {
    if (download.state === "running") {
      res.json({ ...download });
      return;
    }
    download.state = "running";
    download.percent = 0;
    download.error = null;
    download.version = null;
    res.json({ ...download });
    downloadEngine(log)
      .then(() => {
        download.state = "done";
      })
      .catch((err) => {
        download.state = "error";
        download.error = err.message;
        log(`downloading qr-host failed: ${err.message}`);
      })
      .finally(forgetBinary);
  });

  router.get("/download/status", (_req, res) => {
    res.json({ ...download });
  });

  router.post("/start", async (_req, res) => {
    try {
      const settings = readSettings(await getSettings());
      const binary = await findServerBinary(settings.serverPath);
      if (!binary.installed) {
        res.status(400).json({
          error:
            binary.reason === "outdated"
              ? `${binary.path} is qr-host ${binary.version}; this extension needs ${REQUIRED_VERSION} or newer. Update it from the Remote Desktop panel.`
              : "qr-host was not found. Download it from the Remote Desktop panel (see this extension's README) or set its path in Settings.",
        });
        return;
      }
      const userConfig = settings.mode === "managed" && settings.useGlobalConfig;
      if (userConfig && !versionAtLeast(parseVersion(binary.version) ?? [0, 0, 0], parseVersion(USER_CONFIG_VERSION))) {
        res.status(400).json({
          error: `Use global config needs qr-host ${USER_CONFIG_VERSION} or newer; ${binary.path} is ${binary.version}. Update it from the Remote Desktop panel, or turn the setting off.`,
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
        "--ws-listen", `127.0.0.1:${port}`,
        "--listen", "127.0.0.1:0",
        "--no-mdns",
        "--fps", String(settings.fps),
        "--max-kbps", String(settings.bitrateKbps),
        "--config-dir", CONFIG_DIR,
      ];
      if (settings.mode === "managed") {
        // The host owns the virtual display and the desktop: it starts
        // them, resizes the display to the tab, keeps the desktop's scale
        // in step, and ends them with itself.
        args.push(
          "--source", "vdisplay",
          "--desktop", settings.desktopCommand,
          "--size", INITIAL_SIZE,
          "--keyboard-layout", settings.keyboardLayout,
          "--dpi", String(settings.dpi),
        );
        if (settings.renderer === "software") args.push("--vd-software");
        // The desktop's settings (theme, panel, window manager) from
        // ~/.config instead of a fresh directory per Start.
        if (userConfig) args.push("--desktop-user-config");
      } else {
        args.push("--source", settings.display ? `x11:${settings.display}` : "auto");
      }
      await host.sessions.create(SESSION_NAME, os.homedir(), true);
      // The host's output goes to the session and to a file (its log is
      // on stdout), so a failed start or a rate-control question can be
      // read after the fact. No `exec` with a pipeline: closing the window
      // still hangs the host up, and Stop kills the session anyway.
      const line = [
        ":",
        ">",
        shellQuote(HOST_LOG),
        ";",
        "env",
        `RUST_LOG=${shellQuote(HOST_LOG_LEVEL)}`,
        shellQuote(binary.path),
        ...args.map(shellQuote),
        "2>&1",
        "|",
        "tee",
        "-a",
        shellQuote(HOST_LOG),
        ";",
        "exit",
      ].join(" ");
      await host.sessions.sendText(SESSION_NAME, line, true);
      lastPort = port;

      const status = await waitForStatus(port);
      if (!status) {
        await stopEverything();
        log(`qr-host did not answer on ${port} in time; its output is in the ${SESSION_NAME} session`);
        res.status(502).json({
          error: `Remote Desktop did not start in time; see ${HOST_LOG} or the ${SESSION_NAME} session.`,
        });
        return;
      }
      res.json(await statusBody(settings, binary, fromHostStatus(port, status)));
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
      if (!info.displayEnv?.DISPLAY && !info.displayEnv?.WAYLAND_DISPLAY) {
        res.status(400).json({ error: "The host has not reported its display yet; try again in a moment." });
        return;
      }
      // A new window of the session, with the command typed at its shell
      // prompt as the user wrote it. The display rides along on the same
      // line, and so does the desktop scale for toolkits that only read it
      // at startup (Qt; GTK takes it from xsettings but the env is
      // harmless).
      const index = await host.sessions.createWindow(SESSION_NAME, cwd);
      const env = [...scaleEnvironment(info.scale)];
      for (const [k, v] of Object.entries(info.displayEnv)) {
        if (/^[A-Z_][A-Z0-9_]*$/.test(k) && v) env.push([k, v]);
      }
      const prefix = env.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
      await host.sessions.sendText(SESSION_NAME, `${prefix} ${command}`, true, index);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
