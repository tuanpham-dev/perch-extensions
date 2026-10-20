// Sidebar panel: find or download the engine, start, stop, open the
// display, launch a command, and show what the server side reports. Polls
// /status every 2 s, and /download/status every 500 ms while a download
// runs.
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import { fetchDownloadStatus, fetchStatus, getHost, postJson, type DownloadStatus, type RdStatus } from "./host";

const STATUS_POLL_MS = 2000;
const DOWNLOAD_POLL_MS = 500;

const APT_LINE = "sudo apt install -y sway xwayland xdg-desktop-portal-wlr pipewire wireplumber xfce4 dbus-x11 gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-pipewire";

export function RemoteDesktopPanel({ actionsTarget }: { actionsTarget?: HTMLDivElement | null }) {
  const [status, setStatus] = useState<RdStatus | null>(null);
  const [download, setDownload] = useState<DownloadStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState("");

  const poll = useCallback(() => {
    fetchStatus()
      .then((s) => {
        setStatus(s);
        setDownload(s.download);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    poll();
    const id = window.setInterval(poll, STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [poll]);

  // A running download is followed closely; when it ends the next status
  // poll picks up the binary.
  const downloading = download?.state === "running";
  useEffect(() => {
    if (!downloading) return;
    const id = window.setInterval(() => {
      fetchDownloadStatus()
        .then((d) => {
          setDownload(d);
          if (d.state !== "running") poll();
        })
        .catch(() => {
          // The status poll carries on.
        });
    }, DOWNLOAD_POLL_MS);
    return () => window.clearInterval(id);
  }, [downloading, poll]);

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
  const startDownload = () =>
    act(async () => {
      setDownload(await postJson<DownloadStatus>("/download"));
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

  // In the panel header, next to the title — reachable while the status
  // is still loading or failing, which is when the engine path may need
  // fixing.
  const openSettings = getHost().openSettings;
  const header =
    actionsTarget && openSettings
      ? createPortal(
          <button type="button" className="icon-button" title="Remote Desktop Settings" onClick={openSettings}>
            <Icon name="settings-gear" />
          </button>,
          actionsTarget,
        )
      : null;

  if (!status) {
    return (
      <div className="rd-panel rd-panel-status">
        {header}
        {error ?? "Loading…"}
      </div>
    );
  }

  const modeLabel =
    status.mode === "existing"
      ? `Existing display${status.display ? ` ${status.display}` : " (detected)"}`
      : `Managed display · ${status.desktopCommand}`;
  const sourceLabel = { setting: "from Settings", downloaded: "downloaded", path: "on PATH", cargo: "in ~/.cargo/bin" }[status.engineSource ?? "path"];
  const outdated = status.serverReason === "outdated";
  const canStart = status.installed && !status.running;

  return (
    <div className="rd-panel">
      {header}
      <div className="rd-panel-engine">
        <span className="rd-panel-label">Engine</span>
        {status.engineVersion ? (
          <span>
            qr-host {status.engineVersion} <span className="rd-panel-muted">({sourceLabel})</span>
          </span>
        ) : (
          <span className="rd-panel-muted">qr-host not found</span>
        )}
      </div>
      {status.settingIgnored && (
        <div className="rd-panel-status">
          Settings point at <code>{status.settingIgnored}</code>, which is not qr-host (a QuicDesk server from an earlier version); it is
          ignored. Clear <code>remoteDesktop.serverPath</code> to silence this note.
        </div>
      )}
      {!status.installed && !downloading && (
        <div className="rd-panel-status">
          {outdated ? (
            <>
              The engine at <code>{status.serverPath}</code> is {status.engineVersion}; this extension needs {status.requiredVersion} or newer.
            </>
          ) : (
            <>
              Install the host packages (below), then download the engine. Or build it yourself and set its path in Settings.
            </>
          )}
        </div>
      )}
      {(!status.installed || outdated) && !status.running && (
        <div className="rd-panel-row">
          <button className="rd-btn rd-btn-primary" disabled={busy || downloading} onClick={() => void startDownload()}>
            <Icon name="cloud-download" /> {outdated ? `Update to ${status.requiredVersion}` : "Download qr-host"}
          </button>
        </div>
      )}
      {downloading && (
        <div className="rd-panel-download">
          <div className="rd-panel-muted">Downloading qr-host {download?.version ?? ""}… {download?.percent ?? 0}%</div>
          <div className="rd-progress" role="progressbar" aria-valuenow={download?.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <div className="rd-progress-bar" style={{ width: `${download?.percent ?? 0}%` }} />
          </div>
        </div>
      )}
      {download?.state === "error" && download.error && <div className="rd-panel-error">Download failed: {download.error}</div>}
      {status.missing.length > 0 && status.mode === "managed" && (
        <div className="rd-panel-warning">
          Managed mode needs {status.missing.join(", ")} on this host:
          <code className="rd-panel-code">{APT_LINE}</code>
        </div>
      )}
      {canStart && (
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
              Running ({status.mode === "existing" ? "existing display" : "managed"})
              {status.viewers > 0 ? `, ${status.viewers} viewer${status.viewers === 1 ? "" : "s"}` : ""}
            </span>
          </div>
          {status.width > 0 && (
            <div className="rd-panel-muted">
              {status.width}x{status.height}
              {status.scale && status.scale !== 1 ? ` @ ${status.scale}x` : ""}
              {status.encoder ? ` · ${status.encoder}` : ""}
              {status.codec ? ` · ${status.codec}` : ""}
              {status.hostRenderer === "software" ? " · software rendering" : ""}
            </div>
          )}
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
