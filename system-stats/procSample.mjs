// CPU time and memory of every process on the host, and their sums per
// terminal window: a window's shell plus everything descended from it.
//
//   Linux    /proc/<pid>/stat: utime+stime (clock ticks) and rss (pages)
//   macOS    ps -axo pid=,ppid=,time=,rss=   (cumulative CPU time, KB)
//   Windows  the CIM process list: Kernel+UserModeTime (100ns), WorkingSetSize
//
// The tree walk mirrors Perch's own server/src/processes.ts, which extensions
// can't import. CPU % follows top: 100% is one full core, so a busy window on
// a many-core machine can read well over 100.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

// Linux constants: USER_HZ is 100 on every mainstream kernel build, and the
// page size is 4KB on x86 and most arm64 distributions; both are read from
// getconf once when it's available.
let clockTicks = 100;
let pageSize = 4096;
let linuxConstantsRead = false;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

async function readLinuxConstants() {
  if (linuxConstantsRead) return;
  linuxConstantsRead = true;
  const [hz, page] = await Promise.all([run("getconf", ["CLK_TCK"]), run("getconf", ["PAGESIZE"])]);
  if (Number(hz) > 0) clockTicks = Number(hz);
  if (Number(page) > 0) pageSize = Number(page);
}

// One /proc/<pid>/stat line. comm is parenthesized and may contain spaces and
// parens, so the fields are counted from the last ")".
export function parseProcStat(raw, ticksPerSecond = 100, bytesPerPage = 4096) {
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const fields = raw.slice(close + 2).split(" ");
  // fields[0] is state (field 3); ppid is field 4, utime 14, stime 15, rss 24.
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const rss = Number(fields[21]);
  if (![ppid, utime, stime, rss].every(Number.isFinite)) return null;
  return { ppid, cpuTimeMs: ((utime + stime) * 1000) / ticksPerSecond, rssBytes: rss * bytesPerPage };
}

// ps's cumulative CPU time: [[dd-]hh:]mm:ss[.ss].
export function parsePsTime(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return NaN;
  const [, days = "0", hours = "0", minutes, seconds] = m;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 + Number(seconds) * 1000;
}

export function parsePsSample(stdout) {
  const map = new Map();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const cpuTimeMs = parsePsTime(m[3]);
    if (!Number.isFinite(cpuTimeMs)) continue;
    map.set(Number(m[1]), { ppid: Number(m[2]), cpuTimeMs, rssBytes: Number(m[4]) * 1024 });
  }
  return map;
}

// ConvertTo-Json gives an object for one process and an array for several.
export function parseCimSample(json) {
  const map = new Map();
  let rows;
  try {
    rows = JSON.parse(json);
  } catch {
    return map;
  }
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    const pid = Number(row?.ProcessId);
    if (!Number.isFinite(pid)) continue;
    const ticks = Number(row.KernelModeTime ?? 0) + Number(row.UserModeTime ?? 0);
    map.set(pid, {
      ppid: Number(row.ParentProcessId) || 0,
      cpuTimeMs: Number.isFinite(ticks) ? ticks / 10_000 : 0,
      rssBytes: Number(row.WorkingSetSize) || 0,
    });
  }
  return map;
}

// pid -> { ppid, cpuTimeMs, rssBytes } for every process, or null when the
// platform's source can't be read at all.
export async function sampleProcesses() {
  if (process.platform === "darwin") {
    const out = await run("ps", ["-axo", "pid=,ppid=,time=,rss="]);
    return out === null ? null : parsePsSample(out);
  }
  if (process.platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize | ConvertTo-Json -Compress",
    ]);
    return out === null ? null : parseCimSample(out);
  }
  await readLinuxConstants();
  let entries;
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  const map = new Map();
  await Promise.all(
    entries
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        try {
          const info = parseProcStat(await readFile(`/proc/${name}/stat`, "utf8"), clockTicks, pageSize);
          if (info) map.set(Number(name), info);
        } catch {
          // exited between readdir and read
        }
      }),
  );
  return map;
}

// rootPid and every process below it.
export function treeOf(rootPid, sample) {
  const childrenOf = new Map();
  for (const [pid, info] of sample) {
    const siblings = childrenOf.get(info.ppid);
    if (siblings) siblings.push(pid);
    else childrenOf.set(info.ppid, [pid]);
  }
  const out = [];
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (sample.has(pid)) out.push(pid);
    queue.push(...(childrenOf.get(pid) ?? []));
  }
  return out;
}

// Per-window figures from two samples taken `elapsedMs` apart. A process that
// wasn't in the previous sample started since, so all of its CPU time counts.
// Without a previous sample there's no rate yet, and cpuPercent is null.
export function windowFigures(rootPid, sample, previous, elapsedMs) {
  let cpuDeltaMs = 0;
  let rssBytes = 0;
  for (const pid of treeOf(rootPid, sample)) {
    const now = sample.get(pid);
    rssBytes += now.rssBytes;
    const before = previous?.get(pid);
    cpuDeltaMs += Math.max(0, now.cpuTimeMs - (before?.cpuTimeMs ?? 0));
  }
  const cpuPercent = previous && elapsedMs > 0 ? Math.round((cpuDeltaMs / elapsedMs) * 1000) / 10 : null;
  return { cpuPercent, rssBytes };
}
