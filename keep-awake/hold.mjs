// Holding the computer awake: each OS's own mechanism, through a helper
// process that lives as long as the hold. Stops idle system sleep only; the
// screen may still turn off. Every helper watches this server's pid, so a
// crash can't leave the computer unable to sleep.
import { spawn } from "node:child_process";

const WHY = "Keep Awake is on in Perch";

function settle(child, ms) {
  // A helper that's refused exits at once; one still running after `ms` holds.
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    child.once("error", () => finish(false));
    child.once("exit", () => finish(false));
    setTimeout(() => finish(child.exitCode === null && !child.killed), ms);
  });
}

async function holdLinux(pid) {
  const watch = `while kill -0 $PPID 2>/dev/null && kill -0 ${pid} 2>/dev/null; do sleep 15; done`;
  // Blocking sleep needs a desktop session's say-so (polkit); a server
  // started outside one (a systemd user service, ssh) is refused, and
  // blocking idle alone is what's left. --no-ask-password: refused at once
  // rather than waiting on a password prompt nobody sees.
  for (const what of ["sleep:idle", "idle"]) {
    const child = spawn(
      "systemd-inhibit",
      ["--no-ask-password", `--what=${what}`, "--who=Perch", `--why=${WHY}`, "--mode=block", "sh", "-c", watch],
      { stdio: "ignore" },
    );
    if (await settle(child, 400)) return { child, note: what === "idle" ? "idle only, outside a desktop session" : null };
  }
  throw new Error("systemd-inhibit refused to keep this computer awake (it comes with systemd)");
}

async function holdMac(pid) {
  // -i: no idle system sleep; -w: until this server exits, however it does.
  const child = spawn("caffeinate", ["-i", "-w", String(pid)], { stdio: "ignore" });
  if (await settle(child, 300)) return { child, note: null };
  throw new Error("caffeinate couldn't keep this computer awake");
}

async function holdWindows(pid) {
  // SetThreadExecutionState holds while the thread that called it lives;
  // PowerShell calls it again every 30 seconds until this server is gone.
  const script = [
    "$k = Add-Type -PassThru -Name P -Namespace PerchKeepAwake -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
    `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [void]$k::SetThreadExecutionState(0x80000001); Start-Sleep -Seconds 30 }`,
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (await settle(child, 1500)) return { child, note: null };
  throw new Error("PowerShell couldn't keep this computer awake");
}

/** Takes a hold. Resolves { release, note }, or rejects saying why not. */
export async function takeHold() {
  const pid = process.pid;
  const held =
    process.platform === "darwin" ? await holdMac(pid) : process.platform === "win32" ? await holdWindows(pid) : await holdLinux(pid);
  return {
    note: held.note,
    release() {
      try {
        held.child.kill();
      } catch {
        // already gone
      }
    },
  };
}
