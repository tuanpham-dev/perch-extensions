// Server hook for the Remote Desktop extension: finds (or downloads)
// rpc-host (remote-pc) and runs it inside its own terminal session, so the
// streaming port is owned by a terminal's process tree; the core proxy only
// forwards ports it can attribute to a terminal (server/src/ports.ts's
// getTunnelablePorts), and a plain detached child here would get a 403
// from /proxy/<port>/. In managed mode the host itself starts the virtual
// display and the desktop session and takes them down when it exits; Stop
// asks it to exit first, then closes the session. The session is created, typed into and killed
// through the host session API, so this works on whichever terminal
// backend runs it. Ground truth for "running" is what answers on the
// port's /status, never an in-memory flag.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { access, chmod, constants as fsConstants, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const SESSION_NAME = "remote-desktop";
const START_TIMEOUT_MS = 20000;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
// What Launch takes from the host's display environment.
const LAUNCH_ENV = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
const START_POLL_INTERVAL_MS = 250;
// The host tears its virtual display down before it exits, which frees
// the port; Stop waits for that so the next Start finds everything free.
const STOP_TIMEOUT_MS = 5000;
const STATUS_TIMEOUT_MS = 800;
const BIN_CHECK_TIMEOUT_MS = 5000;
const MAX_PORT_SCAN = 200;
const MAX_COMMAND_LENGTH = 500;
const CODECS = ["auto", "h264", "h265"];
// The oldest rpc-host this extension speaks to, and the run options it
// needs (an older build of the same version, such as a machine's own host
// service installed earlier, lacks them and is passed over).
const REQUIRED_VERSION = "0.7.0";
const REQUIRED_FLAGS = ["--ws-listen", "--follower-fps", "--attach", "--stop-ends-sessions", "--follower-size", "--renderer", "--no-port-map", "--rendezvous", "--relay-url"];
// Its private desktop's folders: the runtime folder holds the session's
// sockets (short paths: unix sockets allow ~108 bytes), the WebSocket token
// (0600) and the desktop's own config; the state folder keeps paired
// native clients.
// The user's runtime directory, else a private one in their home (never the
// shared /tmp: another user could make the folder first).
const RPC_RUNTIME_BASE =
  process.getuid && existsSync(`/run/user/${process.getuid()}`) ? `/run/user/${process.getuid()}` : path.join(os.homedir(), ".cache", "perch-remote-desktop", "run");

// One Start or Stop at a time (see the routes).
let serialTail = Promise.resolve();
function serial(fn) {
  const run = serialTail.then(fn, fn);
  serialTail = run.catch(() => {});
  return run;
}
const rpcRuntimeDir = (port) => path.join(RPC_RUNTIME_BASE, `perch-rd-${port}`);

// The rpc-host whose --runtime-dir is `runtime`, by its command line.
async function rpcHostPid(runtime) {
  for (const name of await readdir("/proc").catch(() => [])) {
    if (!/^\d+$/.test(name)) continue;
    const cmd = await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "");
    const args = cmd.split("\0");
    const i = args.indexOf("--runtime-dir");
    // By its arguments, not its name (a renamed binary too).
    if (i >= 0 && args[i + 1] === runtime && args.includes("run")) return Number(name);
  }
  return null;
}

// Ask rpc-host to stop on its own (SIGTERM), so it ends its desktop
// session: a host killed outright leaves sway, the session bus and the
// document portal running, and the portal's mount blocks the folder.
// Resolves to the pid that would not stop, else null.
async function stopRpcHost(runtime) {
  const pid = await rpcHostPid(runtime);
  if (!pid) return null;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return null;
  }
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(pid, 0);
    } catch {
      return null;
    }
  }
  return pid;
}

// Remove a runtime folder; a FUSE mount left inside (the document portal's
// "doc") is unmounted first when removal fails on it.
async function removeRuntime(runtime) {
  try {
    await rm(runtime, { recursive: true, force: true });
  } catch (err) {
    if (err?.code !== "EBUSY") throw err;
    for (const f of ["fusermount3", "fusermount"]) {
      if (await run(f, ["-u", "-z", path.join(runtime, "doc")]).then(() => true, () => false)) break;
    }
    await rm(runtime, { recursive: true, force: true });
  }
}
const RPC_STATE_DIR = path.join(os.homedir(), ".local", "state", "perch-remote-desktop", "rpc-host");
const RPC_LOG_LEVEL = process.env.PERCH_REMOTE_DESKTOP_RPC_LOG || "info";
// Where releases come from; PERCH_REMOTE_DESKTOP_RELEASE_API points the
// download at another server (a test, a mirror).
const RELEASE_API =
  process.env.PERCH_REMOTE_DESKTOP_RELEASE_API || "https://api.github.com/repos/tuanpham-dev/remote-pc-releases/releases/latest";
const DOWNLOAD_DIR = path.join(os.homedir(), ".local", "share", "perch-remote-desktop");
// The running host's log (truncated on each Start) and what it logs: the
// rate controller's decisions are kept, since "why is it slow" is the
// question this file answers.
const HOST_LOG = path.join(DOWNLOAD_DIR, "host.log");
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// Applied when a setting is missing from the settings document (a fresh
// install before the Settings UI ever wrote it).
const DEFAULTS = {
  mode: "managed",
  display: "",
  desktopCommand: "xfce4-session",
  useGlobalConfig: false,
  keyboardLayout: "us",
  port: 14600,
  bitrateKbps: 40000,
  codec: "auto",
  serverPath: "",
  // rpc-host: the UDP port native clients on the network connect to (0:
  // this machine only). 47998 is the always-on service's, 47999 the
  // rendezvous server's.
  udpPort: 48000,
  followerFps: 15,
  followerSize: "1080p",
  renderer: "auto",
  // Ask the router to forward udpPort (PCP, NAT-PMP, UPnP) so native
  // clients outside this network connect directly. Tabs don't need it.
  portMapping: false,
  // A rendezvous server (NAME#KEY) and its WebSocket relay, for native
  // clients outside when the router can't forward. Empty: none.
  rendezvous: "",
  relayUrl: "",
};
const FOLLOWER_SIZES = { "720p": "720", "1080p": "1080", "1440p": "1440", full: "full" };

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

// The commands this file runs itself (rpc-host --version, tar), while they
// run, so deactivate() can end exactly these and nothing else.
const children = new Set();

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { encoding: "utf8", timeout: BIN_CHECK_TIMEOUT_MS, ...opts }, (err, stdout, stderr) => {
      children.delete(child);
      if (err) reject(Object.assign(new Error(stderr.trim() || err.message), { code: err.code }));
      else resolve(stdout);
    });
    children.add(child);
  });
}

// Set while this extension's own session is running (started by /start, or
// found still running from an earlier run of this server): how deactivate()
// stops it. Module-level, since a disable and re-enable within one server
// process reuses this module.
let stopOwnSession = null;
// Aborts a release download in progress.
let downloadCtl = null;

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

// rpc-host wants its per-Start token on every request; it lives in the
// session's runtime folder (0600), so a restarted server still finds it.
async function rpcToken(port) {
  try {
    return (await readFile(path.join(rpcRuntimeDir(port), "ws-token"), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

// The uid owning the loopback TCP listener on `port`, from /proc/net/tcp
// (null: none, or not readable). Another local user can listen on a port
// we expect: only our own listener counts as our host.
async function listenerUid(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      // sl local rem st ... uid: local "0100007F:3909", state 0A = LISTEN
      if (f.length > 7 && f[3] === "0A" && f[1].endsWith(`:${hex}`)) return Number(f[7]);
    }
  }
  return null;
}

// The host's own status line: null when nothing answers there, or when
// what listens there isn't this user's.
async function probeStatus(port) {
  if (process.getuid && (await listenerUid(port)) !== process.getuid()) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), STATUS_TIMEOUT_MS);
  try {
    const token = await rpcToken(port);
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: ctl.signal, headers });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body.viewers === "number" ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The host's status once it answers; `{ failed }` as soon as `failed()`
 * names a reason (the host exited with an error); null at the timeout. */
async function waitForStatus(port, totalMs = START_TIMEOUT_MS, failed = async () => null) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const status = await probeStatus(port);
    if (status) return status;
    const why = await failed();
    if (why) return { failed: why };
    await new Promise((r) => setTimeout(r, START_POLL_INTERVAL_MS));
  }
  return null;
}

/** The first error line in the host's log (it printed one and exited). */
async function hostLogError() {
  const text = await readFile(HOST_LOG, "utf8").catch(() => "");
  const line = text.split("\n").find((l) => /^(Error|error)(\[|:)/.test(l.trim()));
  return line ? line.trim().slice(0, 300) : null;
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
    // Typed into a terminal: a control character (a newline is Enter)
    // never gets there.
    display: String(get("display", DEFAULTS.display)).replace(CONTROL_CHARS, "").trim(),
    desktopCommand: String(get("desktopCommand", DEFAULTS.desktopCommand)).replace(CONTROL_CHARS, "").trim() || DEFAULTS.desktopCommand,
    useGlobalConfig: get("useGlobalConfig", DEFAULTS.useGlobalConfig) === true,
    keyboardLayout: String(get("keyboardLayout", DEFAULTS.keyboardLayout)).replace(CONTROL_CHARS, "").trim() || DEFAULTS.keyboardLayout,
    port: ((p) => (Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : DEFAULTS.port))(Number(get("port", DEFAULTS.port))),
    bitrateKbps: Number(get("bitrateKbps", DEFAULTS.bitrateKbps)) || DEFAULTS.bitrateKbps,
    codec: CODECS.includes(get("codec", DEFAULTS.codec)) ? get("codec", DEFAULTS.codec) : DEFAULTS.codec,
    serverPath: String(raw["remoteDesktop.serverPath"] ?? "").trim(),
    udpPort: Math.max(0, Math.min(65535, Number(get("udpPort", DEFAULTS.udpPort)) || 0)),
    followerFps: Math.max(1, Math.min(30, Math.round(Number(get("followerFps", DEFAULTS.followerFps)) || DEFAULTS.followerFps))),
    renderer: ["auto", "gpu", "software"].includes(get("renderer", DEFAULTS.renderer)) ? get("renderer", DEFAULTS.renderer) : DEFAULTS.renderer,
    followerSize: Object.hasOwn(FOLLOWER_SIZES, get("followerSize", DEFAULTS.followerSize)) ? get("followerSize", DEFAULTS.followerSize) : DEFAULTS.followerSize,
    portMapping: get("portMapping", DEFAULTS.portMapping) === true,
    // NAME[:PORT]#64-hex-digits; anything else is ignored (and said so).
    rendezvous: /^[A-Za-z0-9.\-:\[\]]+#[0-9a-fA-F]{64}$/.test(String(get("rendezvous", "")).trim()) ? String(get("rendezvous", "")).trim() : "",
    relayUrl: /^wss?:\/\/[^\s]+$/.test(String(get("relayUrl", "")).trim()) ? String(get("relayUrl", "")).trim() : "",
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

// The downloaded rpc-host: its folder (bin/, and lib/ with the patched
// wlroots it finds next to itself) is unpacked whole.
const downloadedDir = () => path.join(DOWNLOAD_DIR, "rpc-host");
const downloadedBinary = () => path.join(downloadedDir(), "bin", "rpc-host");

// Where the engine is: the setting, then the rpc-host this extension
// downloaded, then PATH, then cargo's bin dir (the host's PATH often lacks
// it when Perch runs as a service). Cached per candidate list, since the
// binary set only changes with a download or reinstall.
let binaryCache = { key: null, result: null };
function forgetBinary() {
  binaryCache = { key: null, result: null };
}
async function findServerBinary(serverPath) {
  // The setting first, then the download, PATH and cargo's bin dir. A
  // setting that names another program (a leftover path) is skipped and
  // reported rather than hiding a perfectly good download behind it; one
  // that names an rpc-host too old is refused. Older builds elsewhere (a
  // host service's on PATH) are passed over.
  const defaults = [
    ["downloaded", downloadedBinary()],
    ["path", "rpc-host"],
    ["cargo", path.join(os.homedir(), ".cargo", "bin", "rpc-host")],
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
    if (!/^rpc-host\b/.test(out.trim())) {
      if (source === "setting") settingIgnored = candidate;
      continue;
    }
    if (source !== "setting" && settingIgnored === null && serverPath) settingIgnored = serverPath;
    const found = parseVersion(out);
    const version = found ? found.join(".") : null;
    // An older build of the same version lacks the options this extension
    // runs it with: passed over (with why), never started to fail.
    const help = await run(candidate, ["run", "--help"]).catch(() => "");
    const lacking = REQUIRED_FLAGS.filter((f) => !help.includes(f));
    if (found && versionAtLeast(found, required) && lacking.length === 0) {
      binaryCache = { key, result: { installed: true, path: candidate, source, version, reason: null, settingIgnored } };
      return binaryCache.result;
    }
    outdated ??= { installed: false, path: candidate, source, version, reason: lacking.length ? "old-build" : "outdated", lacking, settingIgnored };
    // The Server path setting is an explicit choice: an rpc-host there that
    // is too old is refused (with why), not quietly swapped for another.
    if (source === "setting") break;
  }
  binaryCache = {
    key,
    result: outdated ?? { installed: false, path: candidates[0][1], source: null, version: null, reason: "missing", settingIgnored },
  };
  return binaryCache.result;
}

// ---- Downloading a release ----

// The release build for this machine (arm64: e.g. an Oracle Cloud Ampere
// instance, which has no GPU: rpc-host encodes and renders on the CPU).
const ARCH_ASSET = { x64: "rpc-host-linux-x86_64.tar.gz", arm64: "rpc-host-linux-arm64.tar.gz" };

const download = { state: "idle", percent: 0, error: null, version: null };

// The newest release, looked up at most every 6 hours (or when asked): a
// downloaded engine older than it can be updated from the panel, whatever
// this extension requires.
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
const latest = { version: null, checkedAt: 0, error: null, checking: null };

function checkLatest(force) {
  if (latest.checking) return latest.checking;
  if (!force && Date.now() - latest.checkedAt < UPDATE_CHECK_MS) return Promise.resolve();
  latest.checking = fetchJson(RELEASE_API, AbortSignal.timeout(10000))
    .then((r) => {
      const v = String(r?.tag_name ?? "").replace(/^v/, "");
      latest.version = parseVersion(v) ? v : null;
      latest.error = null;
    })
    .catch((err) => {
      latest.error = err.message;
    })
    .finally(() => {
      latest.checkedAt = Date.now();
      latest.checking = null;
    });
  return latest.checking;
}

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal, headers: { accept: "application/vnd.github+json", "user-agent": "perch-remote-desktop" } });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchText(url, signal) {
  const res = await fetch(url, { signal, headers: { "user-agent": "perch-remote-desktop" } });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

// Fetches the latest release's asset for this machine, checks it against
// the release's SHA256SUMS, unpacks it, and leaves nothing half-written
// behind on failure.
async function downloadEngine(log, signal) {
  const asset = process.platform === "linux" ? ARCH_ASSET[process.arch] : null;
  if (!asset) throw new Error(`no release build for ${process.platform} ${process.arch}; build rpc-host yourself and set its path in Settings`);
  const release = await fetchJson(RELEASE_API, signal);
  download.version = String(release.tag_name ?? "").replace(/^v/, "") || null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const file = assets.find((a) => a.name === asset);
  const sums = assets.find((a) => a.name === "SHA256SUMS");
  if (!file) throw new Error(`the latest release (${release.tag_name}) has no ${asset}`);
  if (!sums) throw new Error(`the latest release (${release.tag_name}) has no SHA256SUMS`);
  const expected = fetchText(sums.browser_download_url, signal).then((text) => {
    const line = text.split("\n").find((l) => l.trim().endsWith(asset));
    const hash = line ? line.trim().split(/\s+/)[0] : null;
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`SHA256SUMS has no entry for ${asset}`);
    return hash.toLowerCase();
  });
  // Awaited after the archive; an early failure must not go unhandled.
  expected.catch(() => {});

  const tmpDir = path.join(DOWNLOAD_DIR, ".tmp");
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  const archive = path.join(tmpDir, asset);
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(file.browser_download_url, { signal: AbortSignal.any([ctl.signal, signal]), headers: { "user-agent": "perch-remote-desktop" } });
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
    const unpacked = path.join(tmpDir, "rpc-host");
    await access(path.join(unpacked, "bin", "rpc-host"), fsConstants.R_OK);
    await chmod(path.join(unpacked, "bin", "rpc-host"), 0o755);
    // The new build must run, be new enough and have the options this
    // extension uses before it replaces a working one.
    const ver = parseVersion(await run(path.join(unpacked, "bin", "rpc-host"), ["--version"]).catch(() => ""));
    if (!ver || !versionAtLeast(ver, parseVersion(REQUIRED_VERSION))) throw new Error(`the release's rpc-host is ${ver ? ver.join(".") : "not runnable here"}; this extension needs ${REQUIRED_VERSION} or newer`);
    const help = await run(path.join(unpacked, "bin", "rpc-host"), ["run", "--help"]).catch(() => "");
    const lacking = REQUIRED_FLAGS.filter((f) => !help.includes(f));
    if (lacking.length) throw new Error(`the release's rpc-host lacks ${lacking.join(", ")}`);
    await mkdir(DOWNLOAD_DIR, { recursive: true });
    // The old folder goes first (a running host keeps its open files).
    await rm(downloadedDir(), { recursive: true, force: true });
    await rename(unpacked, downloadedDir());
    forgetBinary();
    download.percent = 100;
    log(`downloaded rpc-host ${download.version ?? ""} to ${downloadedDir()}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Host packages managed mode needs and this machine lacks.
async function missingPackages(settings) {
  if (settings.mode !== "managed") return [];
  const want = ["sway", "Xwayland", "/usr/libexec/xdg-desktop-portal-wlr", "pipewire", "wireplumber"];
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
  wlroots: null,
  lan: null,
  outside: null,
  rendezvous: null,
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
    // The managed desktop's wlroots: "patched" (shipped with rpc-host) or
    // "system" (this sway isn't one the patched build suits).
    wlroots: status.wlroots === "patched" || status.wlroots === "system" ? status.wlroots : null,
    // Where native clients on the network reach it (null: this machine only).
    lan:
      status.lan && typeof status.lan.name === "string" && Number.isInteger(status.lan.port)
        ? { name: status.lan.name, port: status.lan.port }
        : null,
    // What the internet sees of it: the router mapping's state ("off",
    // "searching", "no-router", "carrier-nat", "mapped", "confirmed"),
    // public endpoint and protocol, and the host's own sentence.
    outside:
      status.outside && typeof status.outside.state === "string"
        ? {
            state: status.outside.state,
            public: typeof status.outside.public === "string" ? status.outside.public : null,
            proto: typeof status.outside.proto === "string" ? status.outside.proto : null,
            line: typeof status.outside.line === "string" ? status.outside.line : "",
          }
        : null,
    // The rendezvous registration ("starting", "registered", "not-answering",
    // "refused"), the address the server saw, why it refused.
    rendezvous:
      status.rendezvous && typeof status.rendezvous.state === "string"
        ? {
            server: typeof status.rendezvous.server === "string" ? status.rendezvous.server : "",
            state: status.rendezvous.state,
            seen: typeof status.rendezvous.seen === "string" ? status.rendezvous.seen : null,
            reason: typeof status.rendezvous.reason === "string" ? status.rendezvous.reason : null,
          }
        : null,
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
      if (status) {
        // A host left running by an earlier run of this server is still
        // this extension's: disabling it stops that one too.
        stopOwnSession = stopEverything;
        return fromHostStatus(port, status);
      }
    }
    return NOT_RUNNING;
  }

  // Killing the session hangs up the host's terminal; the host takes its
  // virtual display and desktop down on that and exits, which closes the
  // port.
  // `known`: the port a Start just used (a host that never answered isn't
  // found by its status, but its folder must still go).
  async function stopEverything(known) {
    const port = typeof known === "number" ? known : (await getRunningInfo()).port;
    const stuck = port ? await stopRpcHost(rpcRuntimeDir(port)) : null;
    if (stuck) {
      log(`rpc-host (pid ${stuck}) did not stop within 8 s; killing it`);
      try {
        process.kill(stuck, "SIGKILL");
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    // Its folder stays while it still runs (its sockets and token).
    let alive = false;
    if (stuck) {
      try {
        process.kill(stuck, 0);
        alive = true;
      } catch {}
    }
    await host.sessions.kill(SESSION_NAME).catch(() => {});
    if (port && !(await waitForSilence(port))) {
      log(`the host on ${port} did not exit after its session was killed`);
    }
    // rpc-host's runtime folder (sockets, the token) goes with it.
    if (port && !alive) await removeRuntime(rpcRuntimeDir(port)).catch((err) => log(`could not remove ${rpcRuntimeDir(port)}: ${err.message}`));
    lastPort = null;
    if (stopOwnSession === stopEverything) stopOwnSession = null;
  }

  async function statusBody(settings, binary, running) {
    // The token goes to this user's own viewer only, through Perch's
    // authenticated API.
    const token = running.running ? await rpcToken(running.port) : null;
    // In the background: the panel's next poll shows what it found.
    void checkLatest(false);
    const found = parseVersion(binary.version ?? "");
    const newest = parseVersion(latest.version ?? "");
    const updateAvailable = binary.source === "downloaded" && binary.installed && !!found && !!newest && versionAtLeast(newest, found) && newest.join(".") !== found.join(".");
    return {
      token,
      latestVersion: latest.version,
      updateAvailable,
      maxKbps: settings.bitrateKbps,
      installed: binary.installed,
      serverPath: binary.path,
      serverReason: binary.reason ?? null,
      engineVersion: binary.version ?? null,
      requiredVersion: REQUIRED_VERSION,
      lacking: binary.lacking ?? [],
      engineSource: binary.source ?? null,
      settingIgnored: binary.settingIgnored ?? null,
      mode: settings.mode,
      display: settings.display,
      desktopCommand: settings.desktopCommand,
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

  // A PIN for pairing a native client (open for 2 minutes).
  router.post("/pin", async (_req, res) => {
    try {
      const running = await getRunningInfo();
      if (!running.running) {
        res.status(409).json({ error: "Remote Desktop is not running." });
        return;
      }
      const token = await rpcToken(running.port);
      const r = await fetch(`http://127.0.0.1:${running.port}/pin`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`rpc-host answered ${r.status}`);
      const body = await r.json();
      res.json({ pin: String(body.pin), seconds: Number(body.seconds) || 120 });
    } catch (err) {
      res.status(502).json({ error: `No PIN: ${err.message}` });
    }
  });

  // Look for a newer release now (the panel's "Check for updates").
  router.post("/check-update", async (_req, res) => {
    await checkLatest(true);
    res.json({ latestVersion: latest.version, error: latest.error });
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
    downloadCtl = new AbortController();
    downloadEngine(log, downloadCtl.signal)
      .then(() => {
        download.state = "done";
      })
      .catch((err) => {
        download.state = "error";
        download.error = err.message;
        log(`downloading rpc-host failed: ${err.message}`);
      })
      .finally(() => {
        downloadCtl = null;
        forgetBinary();
      });
  });

  router.get("/download/status", (_req, res) => {
    res.json({ ...download });
  });

  // Start and Stop one at a time: two quick Starts (or a Start racing a
  // Stop) must not launch two hosts or remove a folder a host is using.
  router.post("/start", (req, res) => serial(() => startRoute(req, res)));
  async function startRoute(_req, res) {
    try {
      const settings = readSettings(await getSettings());
      const binary = await findServerBinary(settings.serverPath);
      if (!binary.installed) {
        res.status(400).json({
          error:
            binary.source === "setting" && (binary.reason === "old-build" || binary.reason === "outdated")
              ? `${binary.path} (the Server path setting) is ${binary.reason === "old-build" ? `an older rpc-host build (it lacks ${binary.lacking.join(", ")})` : `rpc-host ${binary.version}`}; this extension needs ${REQUIRED_VERSION} or newer. Update that build, or clear remoteDesktop.serverPath to use the downloaded one.`
              : binary.reason === "old-build"
              ? `${binary.path} is an older rpc-host build (it lacks ${binary.lacking.join(", ")}). Download the current one from the Remote Desktop panel, or set Server path to a newer build.`
              : binary.reason === "outdated"
                ? `${binary.path} is rpc-host ${binary.version}; this extension needs ${REQUIRED_VERSION} or newer. Update it from the Remote Desktop panel.`
                : "rpc-host was not found. Download it from the Remote Desktop panel (see this extension's README) or set its path in Settings.",
        });
        return;
      }
      const userConfig = settings.mode === "managed" && settings.useGlobalConfig;
      await startRpc(settings, binary, userConfig, res);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  // rpc-host: a private desktop in its own runtime folder, its token
  // written 0600 before the host starts (never on a command line or typed
  // into the session).
  async function startRpc(settings, binary, userConfig, res) {
    const attach = settings.mode !== "managed";
    if ((await getRunningInfo()).running) {
      res.status(409).json({ error: "Remote Desktop is already running." });
      return;
    }
    if (await findSession()) await stopEverything();
    const port = await pickPort(settings.port);
    const runtime = rpcRuntimeDir(port);
    // A folder left from before stays: rpc-host ends what still runs in it
    // (its marker says it's the host's own) before starting anew.
    await mkdir(RPC_RUNTIME_BASE, { recursive: true, mode: 0o700 });
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    // Ours, a real folder (not a link), and private before the token goes in.
    let st = await lstat(runtime);
    if (st.isDirectory() && (!process.getuid || st.uid === process.getuid())) {
      await chmod(runtime, 0o700);
      st = await lstat(runtime);
    }
    if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0) {
      res.status(500).json({ error: `${runtime} is not a private folder of this user; remove it and Start again.` });
      return;
    }
    await mkdir(RPC_STATE_DIR, { recursive: true, mode: 0o700 });
    const tokenFile = path.join(runtime, "ws-token");
    await writeFile(tokenFile, randomBytes(24).toString("hex"), { mode: 0o600 });
    await chmod(tokenFile, 0o600); // an old file keeps its mode otherwise
    const args = [
      "run",
      "--runtime-dir", runtime,
      "--state-dir", RPC_STATE_DIR,
      // IPv4 and IPv6 on the network, or this machine only.
      "--listen", settings.udpPort ? `[::]:${settings.udpPort}` : "127.0.0.1:0",
      ...(settings.udpPort && settings.portMapping ? [] : ["--no-port-map"]),
      ...(settings.udpPort && settings.rendezvous ? ["--rendezvous", settings.rendezvous] : []),
      ...(settings.udpPort && settings.rendezvous && settings.relayUrl ? ["--relay-url", settings.relayUrl] : []),
      // On the network it is found by name (mDNS); a Stop ends native
      // viewers' sessions (they don't retry).
      "--name", `${os.hostname()} (Perch)`,
      ...(settings.udpPort ? [] : ["--no-mdns"]),
      "--stop-ends-sessions",
      "--no-power-hold",
      "--input", "virtual",
      "--ws-listen", `127.0.0.1:${port}`,
      "--ws-token-file", tokenFile,
      // `--opt=value`: a value starting with "-" is still a value.
      `--keyboard-layout=${settings.keyboardLayout}`,
      "--max-kbps", String(settings.bitrateKbps),
      "--follower-fps", String(settings.followerFps),
      "--follower-size", FOLLOWER_SIZES[settings.followerSize],
    ];
    if (attach) {
      // The desktop already on this machine (X11 or a wlroots compositor;
      // the Display setting picks one, else rpc-host finds it), its size kept.
      args.push("--source", "attach");
      if (settings.display) args.push(`--attach=${settings.display}`);
    } else {
      args.push("--ui-scale", "2", `--desktop-command=${settings.desktopCommand}`, "--renderer", settings.renderer);
      if (!userConfig) args.push("--fresh-config");
    }
    if (settings.codec === "h264" || settings.codec === "h265") args.push("--codec", settings.codec === "h265" ? "hevc" : "h264");
    await mkdir(DOWNLOAD_DIR, { recursive: true });
    await host.sessions.create(SESSION_NAME, os.homedir(), true);
    const line = [
      ":", ">", shellQuote(HOST_LOG), ";",
      "env", `RPC_LOG=${shellQuote(RPC_LOG_LEVEL)}`,
      shellQuote(binary.path), ...args.map(shellQuote),
      "2>&1", "|", "tee", "-a", shellQuote(HOST_LOG), ";", "exit",
    ].join(" ");
    // Emptied here too: the typed line's own truncation runs only once the
    // terminal's shell has started, and until then the last run's errors
    // would look like this one's.
    await writeFile(HOST_LOG, "", { mode: 0o600 }).catch(() => {});
    await host.sessions.sendText(SESSION_NAME, line, true);
    lastPort = port;
    stopOwnSession = stopEverything;
    // An error the host printed ends the wait at once, with its words.
    const status = await waitForStatus(port, START_TIMEOUT_MS, hostLogError);
    if (status?.failed) {
      await stopEverything(port);
      log(`rpc-host did not start: ${status.failed}`);
      res.status(502).json({ error: `rpc-host did not start: ${status.failed} (more in ${HOST_LOG})` });
      return;
    }
    if (!status) {
      await stopEverything(port);
      log(`rpc-host did not answer on ${port} in time; its output is in the ${SESSION_NAME} session`);
      res.status(502).json({ error: `Remote Desktop did not start in time; see ${HOST_LOG} or the ${SESSION_NAME} session.` });
      return;
    }
    res.json(await statusBody(settings, binary, fromHostStatus(port, status)));
  }

  router.post("/stop", (_req, res) =>
    serial(async () => {
      try {
        await stopEverything();
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    }),
  );

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
      // Only the display's own variables, and no control characters (the
      // line is typed into a shell): nothing the host reports can set
      // LD_PRELOAD, PATH or the like.
      const env = [...scaleEnvironment(info.scale)];
      for (const k of LAUNCH_ENV) {
        const v = info.displayEnv[k];
        if (typeof v === "string" && v && !/[\x00-\x1f\x7f]/.test(v)) env.push([k, v]);
      }
      const prefix = env.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
      await host.sessions.sendText(SESSION_NAME, `${prefix} ${command}`, true, index);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// Disable or uninstall: stops what this extension started - its own
// session (the host takes its display and desktop down with it), its own
// commands still running, and a download in progress - by its own handles,
// never by a process-name match.
export async function deactivate() {
  downloadCtl?.abort();
  downloadCtl = null;
  for (const child of children) child.kill();
  children.clear();
  const stop = stopOwnSession;
  stopOwnSession = null;
  await stop?.();
}
