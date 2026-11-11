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
  const [pin, setPin] = useState<{ pin: string; until: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  // The PIN's countdown.
  useEffect(() => {
    if (!pin) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= pin.until) setPin(null);
    }, 1000);
    return () => window.clearInterval(id);
  }, [pin]);

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

  // Start waits for the host (up to 20 s on the server): longer than the
  // usual request timeout.
  const start = () => act(async () => setStatus(await postJson<RdStatus>("/start", undefined, 45000)));
  const stop = () =>
    act(async () => {
      await postJson("/stop");
      poll();
    });
  const startDownload = () =>
    act(async () => {
      setDownload(await postJson<DownloadStatus>("/download"));
    });
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const checkUpdate = () =>
    act(async () => {
      const r = await postJson<{ latestVersion: string | null; error: string | null }>("/check-update", undefined, 15000);
      setCheckNote(r.error ? `Couldn't check: ${r.error}` : r.latestVersion ? `Newest release: ${r.latestVersion}` : "No release found");
      poll();
    });
  const pairDevice = () =>
    act(async () => {
      const r = await postJson<{ pin: string; seconds: number }>("/pin");
      setPin({ pin: r.pin, until: Date.now() + r.seconds * 1000 });
      setNow(Date.now());
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
  const oldBuild = status.serverReason === "old-build";
  const canStart = status.installed && !status.running;

  return (
    <div className="rd-panel">
      {header}
      <div className="rd-panel-engine">
        <span className="rd-panel-label">Engine</span>
        {status.engineVersion ? (
          <span>
            rpc-host {status.engineVersion} <span className="rd-panel-muted">({sourceLabel})</span>
          </span>
        ) : (
          <span className="rd-panel-muted">rpc-host not found</span>
        )}
      </div>
      {status.settingIgnored && (
        <div className="rd-panel-status">
          Settings point at <code>{status.settingIgnored}</code>, which is not rpc-host; it is
          ignored. Clear <code>remoteDesktop.serverPath</code> to silence this note.
        </div>
      )}
      {!status.installed && !downloading && (
        <div className="rd-panel-status">
          {status.engineSource === "setting" && (oldBuild || outdated) ? (
            <>
              <code>{status.serverPath}</code> (your Server path setting) is {oldBuild ? `an older build (it lacks ${status.lacking.join(", ")})` : `rpc-host ${status.engineVersion}`}; this extension needs {status.requiredVersion} or newer. Update that build, or clear <code>remoteDesktop.serverPath</code> to use the downloaded one.
            </>
          ) : oldBuild ? (
            <>
              <code>{status.serverPath}</code> is an older rpc-host build (it lacks {status.lacking.join(", ")}); download the current one.
            </>
          ) : outdated ? (
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
      {(!status.installed || outdated) && !status.running && status.engineSource !== "setting" && (
        <div className="rd-panel-row">
          <button className="rd-btn rd-btn-primary" disabled={busy || downloading} onClick={() => void startDownload()}>
            <Icon name="cloud-download" /> {outdated ? `Update to ${status.requiredVersion}` : "Download rpc-host"}
          </button>
        </div>
      )}
      {status.installed && status.engineSource === "downloaded" && !downloading && (
        <div className="rd-panel-row">
          {status.updateAvailable ? (
            <button className="rd-btn" disabled={busy} onClick={() => void startDownload()} title={status.running ? "The new engine runs from the next Start" : undefined}>
              <Icon name="cloud-download" /> Update to {status.latestVersion}
              {status.running ? " (next Start)" : ""}
            </button>
          ) : (
            <button className="rd-btn rd-btn-link" disabled={busy} onClick={() => void checkUpdate()}>
              Check for updates
            </button>
          )}
          {checkNote && !status.updateAvailable && <span className="rd-panel-muted">{checkNote}</span>}
        </div>
      )}
      {downloading && (
        <div className="rd-panel-download">
          <div className="rd-panel-muted">Downloading rpc-host {download?.version ?? ""}… {download?.percent ?? 0}%</div>
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
          {status.wlroots === "system" && (
            <div className="rd-panel-muted">
              The patched wlroots shipped with rpc-host is not in use (it suits sway 1.10 with wlroots 0.18): the desktop works, with frames about 13 ms later.
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
              {status.viewers} viewers share this desktop: one drives (its size, keyboard and mouse); the others watch a lighter stream and can take over.
            </div>
          )}
          {status.lan ? (
            <div className="rd-panel-native">
              <div className="rd-panel-muted">
                Native clients: <strong>{status.lan.name}</strong>, UDP port {status.lan.port}
              </div>
              {pin ? (
                <div className="rd-panel-pin">
                  <div>
                    PIN <code className="rd-pin">{pin.pin}</code>{" "}
                    <span className="rd-panel-muted">({Math.max(0, Math.round((pin.until - now) / 1000))} s)</span>
                  </div>
                  <code className="rd-panel-code">rpc-client pair "{status.lan.name}" --pin {pin.pin}</code>
                  <div className="rd-panel-muted">
                    Then <code>rpc-client connect "{status.lan.name}"</code>. The pairing is kept across Starts. If the client can't reach
                    this machine, open the port here: <code>sudo ufw allow {status.lan.port}/udp</code>
                  </div>
                </div>
              ) : (
                <button className="rd-btn" disabled={busy} onClick={() => void pairDevice()}>
                  <Icon name="key" /> Pair a native client
                </button>
              )}
            </div>
          ) : (
            <div className="rd-panel-muted">Native clients: off (set remoteDesktop.udpPort to a port to let rpc-client on other machines connect).</div>
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
