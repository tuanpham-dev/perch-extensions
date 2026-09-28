// Whether an agent is still running in its window, judged by the window's
// foreground command. A missing window was the only sign of death before, so
// an agent that exited - crashed, /exit, Ctrl-C - inside a window that stayed
// open read as working forever.
//
// A window at a plain shell is not dead at once: it passes through one while
// the launch line runs, and after a Perch restart until the agent is resumed.
// Only a shell that stays a shell for the grace period counts.

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "pwsh", "powershell", "cmd"]);

export const AGENT_EXIT_GRACE_MS = 30_000;

export function isShellCommand(command) {
  const name = String(command ?? "").trim().replace(/^-/, "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
  return SHELLS.has(name);
}

// One per runner. `observe` answers whether the window has now been at a
// shell for the whole grace period; any other command resets its clock.
export function createShellWatch(graceMs = AGENT_EXIT_GRACE_MS) {
  const since = new Map();
  return {
    observe(windowId, command, now) {
      if (!isShellCommand(command)) {
        since.delete(windowId);
        return false;
      }
      if (!since.has(windowId)) since.set(windowId, now);
      return now - since.get(windowId) >= graceMs;
    },
    forget(windowId) {
      since.delete(windowId);
    },
  };
}
