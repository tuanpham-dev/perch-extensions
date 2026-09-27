// Sidebar panel: start, stop, open the display, launch a command, and show
// what the server side reports. Polls /status every 2 s.
import { useCallback, useEffect, useState } from "react";
import Icon from "./Icon";
import { fetchStatus, postJson, getHost, type RdStatus } from "./host";

const STATUS_POLL_MS = 2000;

export function RemoteDesktopPanel() {
  const [status, setStatus] = useState<RdStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState("");

  const poll = useCallback(() => {
    fetchStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    poll();
    const id = window.setInterval(poll, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [poll]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const start = () => act(async () => setStatus(await postJson<RdStatus>("/start")));
  const stop = () =>
    act(async () => {
      await postJson("/stop");
      poll();
    });
  const openDisplay = () => getHost().openViewerTab("remoteDesktopView", "remote-desktop://display", { title: "Remote Desktop" });
  const launch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim()) return;
    void act(async () => {
      const cwd = getHost().getActiveContext().cwd ?? undefined;
      await postJson("/launch", { command: command.trim(), cwd });
      setCommand("");
    });
  };

  if (!status) {
    return <div className="rd-panel rd-panel-status">{error ?? "Loading…"}</div>;
  }

  const modeLabel = status.mode === "existing" ? `Existing display ${status.display}` : `Managed display ${status.display}, ${status.desktopCommand}`;

  return (
    <div className="rd-panel">
      {!status.installed && (
        <div className="rd-panel-status">
          {status.serverReason === "outdated" ? (
            <>
              The server at <code>{status.serverPath}</code> is too old for this extension. Rebuild it from the QuicDesk repository.
            </>
          ) : (
            <>
              quicdesk-server was not found. Install it with <code>cargo install --path crates/server</code> from the QuicDesk
              repository (see this extension's README), or set its path in Settings.
            </>
          )}
        </div>
      )}
      {status.installed && !status.running && (
        <>
          <button className="rd-btn rd-btn-primary" disabled={busy} onClick={() => void start()}>
            <Icon name="play" /> Start Remote Desktop
          </button>
          <div className="rd-panel-muted">{modeLabel}</div>
        </>
      )}
      {status.running && (
        <>
          <div className="rd-panel-row">
            <span className="rd-status-dot rd-status-on" />
            <span>
              Running on {status.display} ({status.mode === "existing" ? "existing display" : "managed"})
              {status.viewers > 0 ? `, ${status.viewers} viewer${status.viewers === 1 ? "" : "s"}` : ""}
              {status.width > 0 ? `, ${status.width}x${status.height}` : ""}
            </span>
          </div>
          <div className="rd-panel-row">
            <button className="rd-btn rd-btn-primary" disabled={busy} onClick={openDisplay}>
              <Icon name="link-external" /> Open Display
            </button>
            <button className="rd-btn" disabled={busy} onClick={() => void stop()}>
              <Icon name="debug-stop" /> Stop
            </button>
          </div>
          {status.viewers > 1 && (
            <div className="rd-panel-muted">
              {status.viewers} viewers share this desktop; one drives its size and scale, the others follow.
            </div>
          )}
          {status.mode === "managed" && (
            <form className="rd-launch-form" onSubmit={launch}>
              <input
                className="rd-input"
                placeholder="Command to launch, e.g. xterm"
                value={command}
                disabled={busy}
                onChange={(e) => setCommand(e.target.value)}
              />
              <button className="rd-btn" type="submit" disabled={busy || !command.trim()}>
                Launch
              </button>
            </form>
          )}
        </>
      )}
      {error && <div className="rd-panel-error">{error}</div>}
    </div>
  );
}
