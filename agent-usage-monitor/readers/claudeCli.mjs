// Claude Code's own numbers, kept fresh by Claude Code. The Claude twin of
// ./codexAppServer.mjs: ask the CLI, once a minute, instead of trusting
// whatever its files last said.
//
// The two files ./claude.mjs reads its limits from only move while a CLI is
// running: ~/.claude.json's cachedUsageUtilization is refreshed by the CLI
// as it works (see ./claudeConfig.mjs), and rate-limit-state.json is
// rewritten each time the status line draws. Between sessions both sit
// still, so the bar shows a percentage from whenever the last CLI exited,
// and a week that has moved on looks the same as one that hasn't.
//
// `claude -p /usage` prints the account's limits and exits, refreshing both
// files on the way out. Verified against Claude Code 2.1.282 on 2026-09-25:
// three to seven seconds, and no transcript left behind with session
// persistence off. Its printed output is discarded; what it wrote to the
// files is what the readers pick up right after. The account token stays
// inside the CLI's process: nothing here reads a credential or talks to a
// network service.
import { spawn as spawnProcess } from "node:child_process";
import { homedir } from "node:os";

export const CLI = "claude";
// --no-session-persistence: a run every minute must not leave a transcript
// every minute, which would show up in `claude --resume` and in this
// extension's own transcript scan. --strict-mcp-config: the user's MCP
// servers have nothing to do with a usage read, and starting them is most
// of what a CLI launch costs.
export const ARGS = ["-p", "/usage", "--no-session-persistence", "--strict-mcp-config"];

// Spawning a CLI is far heavier than reading a file, and these numbers move
// on the order of minutes, so one run serves a minute of polling.
export const REFRESH_INTERVAL_MS = 60_000;
// A CLI that hangs (no network, a stuck update check) is killed rather than
// left to stall every poll behind it.
export const TIMEOUT_MS = 20_000;

// One short-lived process: run, wait for it to exit, done. Resolves true
// when the CLI exited cleanly, false when it couldn't be started, failed or
// was killed at the timeout. Never rejects.
function run(spawn, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      // The output goes nowhere: the CLI's stdout is the same data it writes
      // to its cache, and the cache is what gets read.
      child = spawn(CLI, ARGS, { cwd, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(false);
    }, timeoutMs);
    child.on("exit", (code) => finish(code === 0));
    child.on("error", () => finish(false)); // ENOENT: no CLI on PATH; exit never fires
  });
}

// A refresher: refresh() runs the CLI when a minute has passed since the
// last run started, and otherwise returns the last run's outcome at once.
// Concurrent callers share one run. A run that fails, or is killed, counts
// as a run: the next try is a minute later, so a machine without the CLI on
// PATH pays one failed spawn a minute and nothing more.
//
// spawn, the clock and the working directory are injectable for the tests.
export function createRefresher({
  spawn = spawnProcess,
  intervalMs = REFRESH_INTERVAL_MS,
  timeoutMs = TIMEOUT_MS,
  now = Date.now,
  cwd = homedir(),
} = {}) {
  let last = null; // { at, ok }
  let inFlight = null;
  let runs = 0;

  async function refresh() {
    if (inFlight) return inFlight;
    const at = now();
    if (last && at - last.at < intervalMs) return last.ok;
    runs += 1;
    inFlight = run(spawn, cwd, timeoutMs).then((ok) => {
      last = { at, ok };
      inFlight = null;
      return ok;
    });
    return inFlight;
  }

  return {
    refresh,
    // How many runs have started; for the tests.
    get runs() {
      return runs;
    },
  };
}

const shared = createRefresher();

// Ask the CLI to bring its files up to date, if a minute has passed since it
// last did. Called by the Claude reader on every usage read, which the
// status bar polls every few seconds while a client is open: nothing runs
// while nobody is looking. Resolves once the run is over, so the read that
// triggered it sees fresh files, or at once when no run was due.
export function refreshFromCli() {
  return shared.refresh();
}
