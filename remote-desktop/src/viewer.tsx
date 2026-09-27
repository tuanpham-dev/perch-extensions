// The viewer tab: connects to the running session through the proxy,
// decodes and draws frames, forwards input, follows the tab's size, relays
// clipboard and cursor, pauses while hidden, and reconnects on its own.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import { Connection, type ConnState, type ConnectionStats } from "./connection";
import { createDecoder, type Decoder } from "./decoder";
import { Renderer } from "./render";
import { attachInput } from "./input";
import { createClipboardBridge } from "./clipboard";
import { AnchoredPopover } from "./popover";
import {
  detectedPixelRatio,
  deviceFitToTab,
  deviceRatioChoice,
  effectivePixelRatio,
  fetchStatus,
  getHost,
  setDeviceFitToTab,
  setDeviceRatioChoice,
  syncedRatioChoice,
  type RatioChoice,
  type RdStatus,
} from "./host";
import type { ParsedFrame, ServerHello, ServerMsg } from "./wire";

export interface ViewerProps {
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  setTitle?: (title: string) => void;
}

const RESIZE_DEBOUNCE_MS = 250;
const STATS_REFRESH_MS = 1000;

interface Size {
  width: number;
  height: number;
}

const evenSize = (n: number) => Math.max(2, Math.round(n) & ~1);

export function RemoteDesktopView({ active, toolbarTarget }: ViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<RdStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connState, setConnState] = useState<ConnState>("closed");
  const [decoderKind, setDecoderKind] = useState<"webcodecs" | "wasm" | null>(null);
  const [forceWasm, setForceWasm] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<ConnectionStats | null>(null);
  const [remoteSize, setRemoteSize] = useState<Size>({ width: 0, height: 0 });
  const [canvasBox, setCanvasBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [viewers, setViewers] = useState(0);
  const [clipboardPending, setClipboardPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [docHidden, setDocHidden] = useState(document.hidden);
  const [pixelRatio, setPixelRatio] = useState(effectivePixelRatio());
  const [showScale, setShowScale] = useState(false);
  const [deviceChoice, setDeviceChoice] = useState<RatioChoice | null>(deviceRatioChoice());
  const [fitToTab, setFitToTab] = useState(deviceFitToTab());
  const fitToTabRef = useRef(fitToTab);
  fitToTabRef.current = fitToTab;
  const scaleButtonRef = useRef<HTMLButtonElement | null>(null);
  // The driver's pixel ratio: what a follower lays the picture out by.
  const driverRatioRef = useRef(1);
  // Driver or follower: the display follows one viewer's size and scale;
  // a follower only fits the picture, at the driver's scale.
  const [isDriver, setIsDriver] = useState(true);
  const [desktopScale, setDesktopScale] = useState(1);
  const isDriverRef = useRef(true);
  const desktopScaleRef = useRef(1);
  const wasDriverRef = useRef(false);
  // Bumped by Retry and by a decoder switch: a canvas keeps its first
  // context type for life (2D for WebCodecs, WebGL for the software path),
  // so each rebuild of the stack gets a fresh canvas element.
  const [generation, setGeneration] = useState(0);

  const connectionRef = useRef<Connection | null>(null);
  const helloRef = useRef<ServerHello | null>(null);
  const remoteSizeRef = useRef<Size>({ width: 0, height: 0 });
  const hostSizeRef = useRef<Size>({ width: 0, height: 0 });
  const requestedRef = useRef<Size>({ width: 1280, height: 720 });
  const resizeInFlightRef = useRef(false);
  const resizeQueuedRef = useRef<Size | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const clipboardRef = useRef(createClipboardBridge(setClipboardPending));
  const pixelRatioRef = useRef(pixelRatio);
  pixelRatioRef.current = pixelRatio;

  const load = useCallback(() => {
    setError(null);
    setGeneration((g) => g + 1);
    fetchStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => getHost().onSettingsChange(() => setPixelRatio(effectivePixelRatio())), []);

  // The device pixel ratio changes when the window moves to another
  // monitor or the browser zooms; auto follows it.
  useEffect(() => {
    let mql: MediaQueryList | null = null;
    const watch = () => {
      mql?.removeEventListener("change", onChange);
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener("change", onChange);
    };
    const onChange = () => {
      setPixelRatio(effectivePixelRatio());
      watch();
    };
    watch();
    return () => mql?.removeEventListener("change", onChange);
  }, []);

  const chooseDeviceRatio = (choice: RatioChoice | null) => {
    setDeviceRatioChoice(choice);
    setDeviceChoice(choice);
    setPixelRatio(effectivePixelRatio());
  };

  useEffect(() => {
    const onVisibility = () => setDocHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Place the canvas: the remote screen at its intended CSS size (remote
  // pixels over the pixel ratio, the driver's for a follower), centered in
  // the host. The driver's picture was sized for its tab, so it fills the
  // host even when the size was clamped; a follower's is scaled down to
  // fit, and up as well when this device fits the picture to the tab.
  const layout = useCallback(() => {
    const host = hostSizeRef.current;
    const remote = remoteSizeRef.current;
    if (remote.width === 0 || host.width === 0) return;
    const driving = isDriverRef.current;
    const ratio = (driving ? pixelRatioRef.current : driverRatioRef.current) || 1;
    const cssW = remote.width / ratio;
    const cssH = remote.height / ratio;
    const fit = Math.min(driving || fitToTabRef.current ? Infinity : 1, host.width / cssW, host.height / cssH);
    const width = cssW * fit;
    const height = cssH * fit;
    setCanvasBox({ left: (host.width - width) / 2, top: (host.height - height) / 2, width, height });
  }, []);

  const desiredSize = useCallback((): Size => {
    const host = hostSizeRef.current;
    const hello = helloRef.current;
    const ratio = pixelRatioRef.current;
    let width = evenSize(host.width * ratio);
    let height = evenSize(host.height * ratio);
    if (hello) {
      width = Math.min(width, evenSize(hello.maxWidth));
      height = Math.min(height, evenSize(hello.maxHeight));
    }
    return { width, height };
  }, []);

  const sendResize = useCallback(
    (size: Size) => {
      const conn = connectionRef.current;
      const hello = helloRef.current;
      if (!conn || !hello || !hello.resize || !isDriverRef.current) return;
      if (size.width === remoteSizeRef.current.width && size.height === remoteSizeRef.current.height) return;
      // Already asked for exactly this and still waiting: nothing to add.
      if (resizeInFlightRef.current && size.width === requestedRef.current.width && size.height === requestedRef.current.height) return;
      if (resizeInFlightRef.current) {
        resizeQueuedRef.current = size;
        return;
      }
      resizeInFlightRef.current = true;
      requestedRef.current = size;
      conn.send({ t: "resize", width: size.width, height: size.height });
    },
    [],
  );

  const scheduleResize = useCallback(() => {
    if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      sendResize(desiredSize());
    }, RESIZE_DEBOUNCE_MS);
  }, [desiredSize, sendResize]);

  // Host size tracking.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      hostSizeRef.current = { width: rect.width, height: rect.height };
      layout();
      scheduleResize();
    });
    observer.observe(el);
    const rect = el.getBoundingClientRect();
    hostSizeRef.current = { width: rect.width, height: rect.height };
    requestedRef.current = desiredSize();
    return () => observer.disconnect();
  }, [layout, scheduleResize, desiredSize, status?.running]);

  useEffect(() => {
    layout();
    scheduleResize();
    connectionRef.current?.send({ t: "scale", ratio: pixelRatio });
  }, [pixelRatio, layout, scheduleResize]);

  useEffect(() => {
    layout();
  }, [fitToTab, layout]);

  const chooseFitToTab = (on: boolean) => {
    setDeviceFitToTab(on);
    setFitToTab(on);
  };

  const closeScale = useCallback(() => {
    setShowScale(false);
    canvasRef.current?.focus({ preventScroll: true });
  }, []);

  const applyDriver = useCallback(
    (you: boolean, scale: number, driverRatio: number) => {
      isDriverRef.current = you;
      desktopScaleRef.current = scale;
      driverRatioRef.current = driverRatio;
      setIsDriver(you);
      setDesktopScale(scale);
      if (you) wasDriverRef.current = true;
      layout();
    },
    [layout],
  );

  // The streaming stack, rebuilt when the port or the decoder choice changes.
  useEffect(() => {
    if (!status?.running || !status.port) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let decoder: Decoder | null = null;
    let renderer: Renderer | null = null;
    let detachInput: (() => void) | null = null;
    const port = status.port;

    const toRemote = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const remote = remoteSizeRef.current;
      if (rect.width === 0 || remote.width === 0) return null;
      const x = Math.round(((clientX - rect.left) / rect.width) * remote.width);
      const y = Math.round(((clientY - rect.top) / rect.height) * remote.height);
      return { x: Math.max(0, Math.min(remote.width - 1, x)), y: Math.max(0, Math.min(remote.height - 1, y)) };
    };

    const conn = new Connection(port, {
      requestedSize: () => requestedRef.current,
      pixelRatio: () => pixelRatioRef.current,
      onHello: (hello) => {
        helloRef.current = hello;
        remoteSizeRef.current = { width: hello.width, height: hello.height };
        setRemoteSize(remoteSizeRef.current);
        setViewers(hello.viewers);
        decoder?.reset();
        applyDriver(hello.driver, hello.scale, hello.driverRatio);
        // A driver that lost its seat to a reconnect takes it back.
        if (!hello.driver && wasDriverRef.current) conn.send({ t: "claim" });
        // The hello size already reflects the requested one when the server
        // could resize; otherwise this is a no-op and the canvas scales.
        resizeInFlightRef.current = false;
        scheduleResize();
        if (!active || document.hidden) conn.send({ t: "pause" });
        canvas.focus({ preventScroll: true });
      },
      onFrame: (frame: ParsedFrame) => {
        const header = frame.header;
        if (header.width !== remoteSizeRef.current.width || header.height !== remoteSizeRef.current.height) {
          remoteSizeRef.current = { width: header.width, height: header.height };
          setRemoteSize(remoteSizeRef.current);
          layout();
        }
        renderer?.setSize(header.width, header.height);
        decoder?.decode(frame);
      },
      onMessage: (msg: ServerMsg) => {
        switch (msg.t) {
          case "driver":
            applyDriver(msg.you, msg.scale, msg.driverRatio);
            if (msg.you) scheduleResize();
            break;
          case "resized": {
            // The display is shared: this may answer another viewer's
            // request, and the display takes whichever size was asked for
            // last. Never re-request here just because the size is not
            // ours, or two viewers of different sizes fight forever; a
            // viewer asks only when its own host changes.
            remoteSizeRef.current = { width: msg.width, height: msg.height };
            setRemoteSize(remoteSizeRef.current);
            layout();
            const wasMine = resizeInFlightRef.current;
            resizeInFlightRef.current = false;
            const queued = resizeQueuedRef.current;
            resizeQueuedRef.current = null;
            if (queued) sendResize(queued);
            else if (wasMine) {
              // The host changed while our request was out: ask once more
              // for what it wants now (not for what the server answered).
              const want = desiredSize();
              const asked = requestedRef.current;
              if (want.width !== asked.width || want.height !== asked.height) scheduleResize();
            }
            break;
          }
          case "clipboard":
            void clipboardRef.current.remoteText(msg.text);
            break;
          case "cursor":
            canvas.style.cursor = `url(data:image/png;base64,${msg.png}) ${msg.xhot} ${msg.yhot}, auto`;
            break;
          case "viewers":
            setViewers(msg.n);
            break;
          case "error":
            setNotice(msg.reason);
            break;
          default:
            break;
        }
      },
      onState: (state, attempt) => {
        setConnState(state);
        if (state === "reconnecting") {
          resizeInFlightRef.current = false;
          resizeQueuedRef.current = null;
          // Past the first quick retry, ask the server side whether the
          // session still exists: after Stop there is nothing to reconnect
          // to, and the tab should say so instead of retrying forever.
          if (attempt >= 2) {
            fetchStatus()
              .then((s) => {
                if (!s.running) setStatus(s);
              })
              .catch(() => {
                // The host itself is away; keep retrying the socket.
              });
          }
        }
      },
    });
    connectionRef.current = conn;

    createDecoder({
      forceWasm,
      workerUrl: getHost().assetUrl("dist/workers/h264.js"),
      onPicture: (picture, decodeMs) => {
        conn.reportDecode(decodeMs);
        if (disposed) {
          if (picture.kind === "video") picture.frame.close();
          return;
        }
        renderer?.draw(picture);
      },
      onNeedKeyframe: () => conn.send({ t: "keyframe" }),
    })
      .then((d) => {
        if (disposed) {
          d.close();
          return;
        }
        decoder = d;
        setDecoderKind(d.kind);
        renderer = new Renderer(canvas, d.kind === "webcodecs" ? "2d" : "webgl");
        if (!renderer.ready) {
          setError("This browser cannot draw the stream (no canvas context).");
          return;
        }
        detachInput = attachInput(canvas, {
          send: (msg) => conn.send(msg),
          toRemote,
          onClipboardTruncated: () => setNotice("Pasted text was cut at 1 MB."),
        });
        conn.start();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));

    const statsTimer = window.setInterval(() => setStats({ ...conn.stats }), STATS_REFRESH_MS);

    return () => {
      disposed = true;
      window.clearInterval(statsTimer);
      detachInput?.();
      conn.stop();
      decoder?.close();
      connectionRef.current = null;
      helloRef.current = null;
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
    };
    // `active` is handled by the pause effect below; rebuilding on it would
    // reconnect on every tab switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.running, status?.port, forceWasm, generation]);

  // Pause while nobody can see the tab.
  useEffect(() => {
    const conn = connectionRef.current;
    if (!conn || conn.state !== "open") return;
    conn.send({ t: active && !docHidden ? "resume" : "pause" });
    if (active && !docHidden) canvasRef.current?.focus({ preventScroll: true });
  }, [active, docHidden, connState]);

  // Fullscreen with Keyboard Lock where the browser has it (Chromium).
  const keyboard = (navigator as unknown as { keyboard?: { lock?: () => Promise<void>; unlock?: () => void } }).keyboard;
  useEffect(() => {
    const onChange = () => {
      const on = document.fullscreenElement === hostRef.current;
      setIsFullscreen(on);
      if (!on) keyboard?.unlock?.();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFullscreen = async () => {
    if (isFullscreen) {
      await document.exitFullscreen();
      return;
    }
    await hostRef.current?.requestFullscreen();
    try {
      await keyboard?.lock?.();
    } catch {
      // Fullscreen without reclaimed shortcuts; Escape still exits.
    }
    canvasRef.current?.focus({ preventScroll: true });
  };

  const takeOver = () => {
    wasDriverRef.current = true;
    connectionRef.current?.send({ t: "claim" });
  };

  const copyPending = async () => {
    const ok = await clipboardRef.current.copyPending();
    setNotice(ok ? "Copied the desktop's clipboard." : "The browser refused the clipboard write.");
    window.setTimeout(() => setNotice(null), 2500);
  };

  // The host keeps inactive tabs mounted and shares the toolbar slot, so
  // the buttons belong there only while this tab is the active one.
  const toolbar =
    toolbarTarget && status?.running && active
      ? createPortal(
          <div className="rd-toolbar">
            <button
              className={`rd-tool${showStats ? " rd-tool-on" : ""}`}
              title="Connection stats"
              onClick={() => setShowStats((v) => !v)}
            >
              <Icon name="graph" />
            </button>
            <button
              className={`rd-tool${clipboardPending ? " rd-tool-attention" : ""}`}
              title={clipboardPending ? "Copy the desktop's clipboard (waiting)" : "Copy the desktop's clipboard"}
              disabled={!clipboardPending}
              onClick={() => void copyPending()}
            >
              <Icon name="clippy" />
            </button>
            <button
              ref={scaleButtonRef}
              data-menu-trigger="true"
              aria-haspopup="dialog"
              aria-expanded={showScale}
              className={`rd-tool${showScale ? " rd-tool-on" : ""}`}
              title="View settings for this device: pixel ratio, fit to tab"
              onClick={() => setShowScale((v) => !v)}
            >
              <Icon name="zoom-in" />
            </button>
            {document.fullscreenEnabled && (
              <button
                className="rd-tool"
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen (Chromium also hands browser shortcuts to the desktop; Ctrl+W stays with the browser)"}
                onClick={() => void toggleFullscreen()}
              >
                <Icon name={isFullscreen ? "screen-normal" : "screen-full"} />
              </button>
            )}
          </div>,
          toolbarTarget,
        )
      : null;

  if (error) {
    return (
      <div className="rd-view-host rd-view-empty">
        <div className="rd-view-status rd-view-error">
          {error}
          <button className="rd-btn" onClick={load}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="rd-view-host rd-view-empty">
        <div className="rd-view-status">Loading…</div>
      </div>
    );
  }
  if (!status.running || !status.port) {
    return (
      <div className="rd-view-host rd-view-empty">
        <div className="rd-view-status">
          No remote desktop is running. Start one from the Remote Desktop sidebar panel.
          <button className="rd-btn" onClick={load}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={hostRef} className={`rd-view-host${isFullscreen ? " rd-view-fullscreen" : ""}`}>
      {toolbar}
      <canvas
        key={`${forceWasm ? "wasm" : "webcodecs"}-${generation}`}
        ref={canvasRef}
        // In fullscreen every key belongs to the desktop: Perch's own
        // shortcuts stand down (core honours this attribute) and Keyboard
        // Lock takes the browser's. Outside fullscreen the app keeps them.
        data-keyboard-capture="fullscreen"
        className="rd-view-canvas"
        tabIndex={0}
        style={canvasBox ? { left: canvasBox.left, top: canvasBox.top, width: canvasBox.width, height: canvasBox.height } : { left: 0, top: 0, width: "100%", height: "100%" }}
      />
      {connState === "connecting" && <div className="rd-view-overlay">Connecting…</div>}
      {connState === "reconnecting" && <div className="rd-view-overlay rd-view-overlay-soft">Connection lost, reconnecting…</div>}
      {decoderKind === "wasm" && (
        <div className="rd-view-banner">
          Software decoder in use{forceWasm ? " (forced)" : ": this browser has no WebCodecs"}. Expect higher CPU use; a lower pixel ratio helps.
        </div>
      )}
      {showScale && (
        <AnchoredPopover anchorRef={scaleButtonRef} onClose={closeScale} label="View settings for this device" className="rd-popover">
          <div className="rd-popover-section">
            <div className="rd-popover-title">Pixel ratio on this device</div>
            <label className="rd-popover-option">
              <input type="radio" name="rd-ratio" checked={deviceChoice === null} onChange={() => chooseDeviceRatio(null)} />
              <span>Synced setting</span>
              <span className="rd-popover-hint">
                {syncedRatioChoice() === "auto" ? `auto, ${detectedPixelRatio()}x here` : `${syncedRatioChoice()}x`}
              </span>
            </label>
            {(["auto", "1", "1.5", "2"] as RatioChoice[]).map((c) => (
              <label key={c} className="rd-popover-option">
                <input type="radio" name="rd-ratio" checked={deviceChoice === c} onChange={() => chooseDeviceRatio(c)} />
                <span>{c === "auto" ? "Auto" : `${c}x`}</span>
                {c === "auto" && <span className="rd-popover-hint">{detectedPixelRatio()}x detected</span>}
              </label>
            ))}
          </div>
          <div className="rd-popover-section">
            <div className="rd-popover-title">View</div>
            <label className="rd-popover-option">
              <input type="checkbox" checked={fitToTab} onChange={(e) => chooseFitToTab(e.target.checked)} />
              <span>Fit the picture to the tab (keeps the aspect ratio)</span>
            </label>
          </div>
          <div className="rd-popover-footer">
            {isDriver
              ? `This tab drives: the desktop follows its size at ${pixelRatio}x.`
              : `Following another viewer at ${desktopScale}x; fitting scales its picture up or down to fill this tab.`}
          </div>
        </AnchoredPopover>
      )}
      {!isDriver && connState === "open" && (
        <div className="rd-view-follow">
          Following another viewer at {remoteSize.width}x{remoteSize.height}, scale {desktopScale}x.
          <button className="rd-btn rd-btn-small" onClick={takeOver}>
            Take over
          </button>
        </div>
      )}
      {notice && <div className="rd-view-notice">{notice}</div>}
      {showStats && (
        <div className="rd-view-stats">
          <div>
            {remoteSize.width}x{remoteSize.height} @ {pixelRatio.toFixed(2)}x, {decoderKind ?? "no decoder"}, {isDriver ? "driver" : `follower of ${desktopScale}x`}
          </div>
          <div>
            {stats ? `${stats.fps.toFixed(1)} fps, ${Math.round(stats.kbps)} kbps, rtt ${stats.rttMs.toFixed(0)} ms` : "no stats yet"}
          </div>
          <div>{stats ? `decode ${stats.decodeMs.toFixed(1)} ms, gaps ${stats.gaps}, viewers ${viewers}` : ""}</div>
          <label className="rd-view-stats-toggle">
            <input type="checkbox" checked={forceWasm} onChange={(e) => setForceWasm(e.target.checked)} /> force software decoder
          </label>
        </div>
      )}
    </div>
  );
}
