// The viewer tab: connects to the running qr-host through the proxy,
// decodes and draws frames, forwards input, asks for the display size and
// scale it wants while it drives, relays clipboard, cursor shapes, audio
// and files, pauses while hidden, and reconnects on its own.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import { Connection, type ConnState, type ConnectionStats } from "./connection";
import { createDecoder, hasWebCodecs, probeDecoders, type Decoder } from "./decoder";
import { Renderer } from "./render";
import { attachInput } from "./input";
import { attachPhoneKeyboard, isTouchDevice, type PhoneKeyboard } from "./keyboard";
import {
  ACTION_LABEL,
  DEFAULT_KEYS,
  STRIP_KEYS,
  TAP_ACTIONS,
  loadGestures,
  normalizeGestures,
  saveGestures,
  stripKeys,
  type Action,
  type GestureSettings,
  type StripKey,
} from "./gestures";
import { createClipboardBridge } from "./clipboard";
import { createFileTransfer, type FileTransfer } from "./files";
import { AudioPipe } from "./audio";
import { AnchoredPopover } from "./popover";
import { fetchStatus, getHost, type RdStatus } from "./host";
import {
  PRESETS,
  RATES,
  clampSize,
  detectedPixelRatio,
  deviceRatioChoice,
  effectivePixelRatio,
  fsControlsPos,
  loadViewSettings,
  saveViewSettings,
  setDeviceRatioChoice,
  setFsControlsPos,
  syncedRatioChoice,
  viewerId,
  type ControlsPos,
  type Quality,
  type RatioChoice,
  type ViewMode,
  type TouchMode,
  type ViewSettings,
} from "./settings";
import { View, ZOOM_MAX, ZOOM_MIN, type Box } from "./view";
import { ClipKind, DisplayKind, DisplayTarget, Kind, QualityLevel, decodeAudio, type CodecCap, type Msg } from "./qr/proto";
import { codecLabel } from "./wire";

export interface ViewerProps {
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  setTitle?: (title: string) => void;
}

const REQUEST_DEBOUNCE_MS = 300;
const STATS_REFRESH_MS = 1000;
// Protocol error codes the viewer reacts to.
const ERROR_BUSY = 6;
const ERROR_REPLACED = 10;

interface Size {
  width: number;
  height: number;
}

// How far a finger may move on the fullscreen controls and still tap.
const DRAG_THRESHOLD_PX = 6;
// A tab smaller than this in either direction is hidden or collapsed, not
// a size anyone wants the desktop to take.
const MIN_FOLLOW_PX = 64;

const QUALITY_LEVEL: Record<Quality, number> = { high: QualityLevel.HIGH, medium: QualityLevel.MEDIUM, low: QualityLevel.LOW };

/** The size a tab asks for when following: even, within what the host takes. */
function followSize(cssWidth: number, cssHeight: number, ratio: number): [number, number] {
  const even = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v))) & ~1;
  return [even(cssWidth * ratio, 320, 7680), even(cssHeight * ratio, 200, 4320)];
}

export function RemoteDesktopView({ active, toolbarTarget }: ViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<RdStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connState, setConnState] = useState<ConnState>("closed");
  const [codec, setCodec] = useState<number | null>(null);
  const [encoder, setEncoder] = useState<string | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [stats, setStats] = useState<ConnectionStats | null>(null);
  const [remoteSize, setRemoteSize] = useState<Size>({ width: 0, height: 0 });
  const [canvasBox, setCanvasBox] = useState<Box | null>(null);
  const [viewers, setViewers] = useState(0);
  const [clipboardPending, setClipboardPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [docHidden, setDocHidden] = useState(document.hidden);
  const [pixelRatio, setPixelRatio] = useState(effectivePixelRatio());
  const [showView, setShowView] = useState(false);
  const [deviceChoice, setDeviceChoice] = useState<RatioChoice | null>(deviceRatioChoice());
  const [viewSettings, setViewSettings] = useState<ViewSettings>(loadViewSettings());
  const [customSize, setCustomSize] = useState<{ w: string; h: string }>({ w: "", h: "" });
  const [zoomPct, setZoomPct] = useState(100);
  const [cursorInPicture, setCursorInPicture] = useState(false);
  const [audioOn, setAudioOn] = useState(false);
  const [audioPackets, setAudioPackets] = useState(0);
  const viewButtonRef = useRef<HTMLButtonElement | null>(null);
  // Driver or follower: the display follows one viewer's size and scale;
  // a follower only fits the picture, at the driver's scale.
  const [isDriver, setIsDriver] = useState(true);
  const [desktopScale, setDesktopScale] = useState(1);
  const isDriverRef = useRef(true);
  const driverRatioRef = useRef(1);
  const wasDriverRef = useRef(false);
  // Set on each (re)connect and cleared by the first seat message after
  // it: only that first seat may trigger a claim-back, so a driver that is
  // taken over later does not snatch the seat straight back.
  const firstSeatRef = useRef(false);
  // Bumped by Retry: each rebuild of the stack gets a fresh canvas element.
  const [generation, setGeneration] = useState(0);

  const connectionRef = useRef<Connection | null>(null);
  const decoderRef = useRef<Decoder | null>(null);
  const remoteSizeRef = useRef<Size>({ width: 0, height: 0 });
  const hostSizeRef = useRef<Size>({ width: 0, height: 0 });
  const requestTimerRef = useRef<number | null>(null);
  const lastRequestRef = useRef("");
  const displayKindRef = useRef(-1);
  const infoSeenRef = useRef(false);
  const clipboardRef = useRef(createClipboardBridge(setClipboardPending));
  const filesRef = useRef<FileTransfer | null>(null);
  const audioRef = useRef<AudioPipe | null>(null);
  const cursorUrlRef = useRef<string | null>(null);
  const applyCursorRef = useRef<(() => void) | null>(null);
  const pixelRatioRef = useRef(pixelRatio);
  pixelRatioRef.current = pixelRatio;
  const viewSettingsRef = useRef(viewSettings);
  viewSettingsRef.current = viewSettings;
  // The phone keyboard: offered on touch devices. While it is up the
  // picture fits into what is left above it and the extra keys, and the
  // desktop keeps its size, so opening it does not reflow every app.
  const [touch, setTouch] = useState(isTouchDevice());
  const [kbOpen, setKbOpen] = useState(false);
  const [armedKeys, setArmedKeys] = useState<ReadonlySet<number>>(new Set());
  const [lockedKeys, setLockedKeys] = useState<ReadonlySet<number>>(new Set());
  // Gestures, trackpad speed, scrolling, the Back button and the strip's
  // keys, kept per device.
  const [gestures, setGestures] = useState<GestureSettings>(loadGestures());
  const gesturesRef = useRef(gestures);
  gesturesRef.current = gestures;
  const applyGestures = useCallback((next: Partial<GestureSettings>) => {
    const merged = normalizeGestures({ ...gesturesRef.current, ...next });
    gesturesRef.current = merged;
    saveGestures(merged);
    setGestures(merged);
  }, []);
  // How much of the host the phone keyboard covers: nothing in a tab,
  // where Perch already sizes the app to the space above it, but the whole
  // keyboard in fullscreen, where the element keeps the screen's size.
  const [kbInset, setKbInset] = useState(0);
  const kbInsetRef = useRef(0);
  // The floating fullscreen controls: where this device keeps them, and the
  // drag in progress (a tap under DRAG_THRESHOLD_PX stays a tap).
  const [fsPos, setFsPos] = useState<ControlsPos>(fsControlsPos());
  const fsPosRef = useRef(fsPos);
  fsPosRef.current = fsPos;
  const fsControlsRef = useRef<HTMLDivElement | null>(null);
  const fsDragRef = useRef<{ id: number; startX: number; startY: number; left: number; top: number; dragging: boolean } | null>(null);
  const fsSuppressClickRef = useRef(false);
  const kbOpenRef = useRef(false);
  const kbRef = useRef<PhoneKeyboard | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  // The view transform: created once; its stage is the host minus the
  // phone keyboard's strip and inset.
  const viewRef = useRef<View | null>(null);
  if (!viewRef.current) {
    viewRef.current = new View({
      size: () => {
        const full = hostSizeRef.current;
        const stripHeight = kbOpenRef.current ? (stripRef.current?.offsetHeight ?? 0) : 0;
        return { width: full.width, height: Math.max(0, full.height - stripHeight - kbInsetRef.current) };
      },
      origin: () => {
        const rect = hostRef.current?.getBoundingClientRect();
        return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
      },
    });
    viewRef.current.onChange = (box) => {
      setCanvasBox({ ...box });
      setZoomPct(Math.round(viewRef.current!.zoom * 100));
    };
  }
  const view = viewRef.current;

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

  const showNotice = useCallback((text: string | null, ms = 2500) => {
    setNotice(text);
    if (text && ms > 0) window.setTimeout(() => setNotice((n) => (n === text ? null : n)), ms);
  }, []);

  // Place the canvas: the picture at the view's scale (the driver's pixel
  // ratio for a follower), centered in the host, panned when zoomed.
  const layout = useCallback(() => {
    let inset = 0;
    const vv = window.visualViewport;
    if (kbOpenRef.current && vv && hostRef.current) {
      const bottom = hostRef.current.getBoundingClientRect().bottom;
      inset = Math.max(0, Math.round(bottom - (vv.offsetTop + vv.height)));
    }
    kbInsetRef.current = inset;
    setKbInset(inset);
    if (remoteSizeRef.current.width === 0 || hostSizeRef.current.width === 0) return;
    view.ratio = (isDriverRef.current ? pixelRatioRef.current : driverRatioRef.current) || 1;
    view.mode = viewSettingsRef.current.view;
    view.zoomLocked = viewSettingsRef.current.lockZoom;
    view.picture = { ...remoteSizeRef.current };
    view.layout();
    applyCursorRef.current?.();
    // The drawn pointer (trackpad mode) sits in picture coordinates: a
    // pan or zoom moves it too.
    setLayoutTick((n) => n + 1);
  }, [view]);

  /** The size, refresh and scale to ask the host for. */
  const wanted = useCallback(() => {
    const ratio = pixelRatioRef.current;
    const s = viewSettingsRef.current;
    const host = hostSizeRef.current;
    const [width, height] = s.sizeMode === "fixed" ? clampSize(s.fixedW, s.fixedH) : followSize(host.width, host.height, ratio);
    return { width, height, refresh: s.hz, scalePct: Math.round(ratio * 100), target: DisplayTarget.VIRTUAL };
  }, []);

  /** Asks the host for the display this tab wants, 300 ms after the last
   * change; only the driver's requests apply, and a fixed desktop (X11)
   * keeps its size. */
  const requestDisplay = useCallback(
    (now = false) => {
      if (requestTimerRef.current !== null) window.clearTimeout(requestTimerRef.current);
      requestTimerRef.current = window.setTimeout(
        () => {
          requestTimerRef.current = null;
          const conn = connectionRef.current;
          if (!conn || conn.state !== "open" || !isDriverRef.current) return;
          if (displayKindRef.current < 0 || displayKindRef.current === DisplayKind.FIXED) return;
          // The phone keyboard only covers the tab for a while: fit the
          // picture, keep the desktop's size.
          if (kbOpenRef.current && viewSettingsRef.current.sizeMode === "follow") return;
          // A tab that is hidden or collapsed measures (nearly) nothing;
          // asking for that would shrink the desktop for every viewer.
          if (viewSettingsRef.current.sizeMode === "follow") {
            const host = hostSizeRef.current;
            if (document.hidden || host.width < MIN_FOLLOW_PX || host.height < MIN_FOLLOW_PX) return;
          }
          const w = wanted();
          const key = JSON.stringify(w);
          if (key === lastRequestRef.current) return;
          lastRequestRef.current = key;
          conn.send({ t: "DisplayRequest", stream: 0, ...w });
        },
        now ? 0 : REQUEST_DEBOUNCE_MS,
      );
    },
    [wanted],
  );

  const sendQuality = useCallback(() => {
    connectionRef.current?.send({ t: "Quality", level: QUALITY_LEVEL[viewSettingsRef.current.quality] });
  }, []);

  // Host size tracking.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      hostSizeRef.current = { width: rect.width, height: rect.height };
      layout();
      if (viewSettingsRef.current.sizeMode === "follow") requestDisplay();
    });
    observer.observe(el);
    const rect = el.getBoundingClientRect();
    hostSizeRef.current = { width: rect.width, height: rect.height };
    return () => observer.disconnect();
  }, [layout, requestDisplay, status?.running]);

  useEffect(() => {
    layout();
    requestDisplay();
  }, [pixelRatio, layout, requestDisplay]);

  useEffect(() => {
    const mql = window.matchMedia("(pointer: coarse)");
    const onChange = () => setTouch(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // The strip mounts with the keyboard: lay out again once it has a height,
  // and follow the visual viewport while the phone keyboard slides in.
  useEffect(() => {
    layout();
    const vv = window.visualViewport;
    if (!kbOpen || !vv) return;
    vv.addEventListener("resize", layout);
    vv.addEventListener("scroll", layout);
    return () => {
      vv.removeEventListener("resize", layout);
      vv.removeEventListener("scroll", layout);
    };
  }, [kbOpen, layout]);

  const applyViewSettings = useCallback(
    (next: Partial<ViewSettings>) => {
      const merged = { ...viewSettingsRef.current, ...next };
      viewSettingsRef.current = merged;
      saveViewSettings(merged);
      setViewSettings(merged);
      layout();
      if ("sizeMode" in next || "fixedW" in next || "fixedH" in next || "hz" in next) requestDisplay(true);
      if ("quality" in next) sendQuality();
    },
    [layout, requestDisplay, sendQuality],
  );

  const applyCustomSize = () => {
    const w = Number(customSize.w);
    const h = Number(customSize.h);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    const [fixedW, fixedH] = clampSize(w, h);
    applyViewSettings({ sizeMode: "fixed", fixedW, fixedH });
  };

  const closeView = useCallback(() => {
    setShowView(false);
    canvasRef.current?.focus({ preventScroll: true });
  }, []);

  const applyDriver = useCallback(
    (you: boolean, scale: number, driverRatio: number) => {
      const was = isDriverRef.current;
      isDriverRef.current = you;
      driverRatioRef.current = driverRatio;
      setIsDriver(you);
      setDesktopScale(scale);
      if (you) wasDriverRef.current = true;
      layout();
      if (you && !was) {
        lastRequestRef.current = "";
        requestDisplay(true);
        sendQuality();
      }
    },
    [layout, requestDisplay, sendQuality],
  );

  // The host's cursor image is in remote pixels; CSS draws a cursor image
  // pixel for pixel, so at a pixel ratio above 1 it is scaled down to the
  // picture's CSS size first, hotspot included, or it would show at twice
  // the size with the tip in the wrong place.
  const cursorRef = useRef<{ png: Uint8Array; xhot: number; yhot: number; width: number; height: number } | null>(null);
  // Trackpad mode draws the desktop's pointer itself (a phone has none).
  const [padPos, setPadPos] = useState<{ x: number; y: number } | null>(null);
  const [, setLayoutTick] = useState(0);
  const [padCursor, setPadCursor] = useState<{ url: string; xhot: number; yhot: number; width: number; height: number } | null>(null);
  const cursorAppliedRef = useRef<{ png: Uint8Array; ratio: number } | null>(null);
  const applyCursor = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const shape = cursorRef.current;
    const ratio = view.ratio || 1;
    if (!shape) {
      if (cursorUrlRef.current) URL.revokeObjectURL(cursorUrlRef.current);
      cursorUrlRef.current = null;
      cursorAppliedRef.current = null;
      canvas.style.cursor = "";
      return;
    }
    const applied = cursorAppliedRef.current;
    if (applied && applied.png === shape.png && applied.ratio === ratio) return;
    cursorAppliedRef.current = { png: shape.png, ratio };
    const blob = new Blob([shape.png as BlobPart], { type: "image/png" });
    const show = (url: string, scale: number) => {
      if (cursorAppliedRef.current?.png !== shape.png || cursorAppliedRef.current.ratio !== ratio) return;
      if (cursorUrlRef.current) URL.revokeObjectURL(cursorUrlRef.current);
      cursorUrlRef.current = url.startsWith("blob:") ? url : null;
      canvas.style.cursor = `url(${url}) ${Math.round(shape.xhot * scale)} ${Math.round(shape.yhot * scale)}, default`;
    };
    if (ratio === 1 || typeof createImageBitmap === "undefined") {
      show(URL.createObjectURL(blob), 1);
      return;
    }
    createImageBitmap(blob)
      .then((bmp) => {
        const scale = 1 / ratio;
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(bmp.width * scale));
        c.height = Math.max(1, Math.round(bmp.height * scale));
        c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close();
        show(c.toDataURL("image/png"), scale);
      })
      .catch(() => show(URL.createObjectURL(blob), 1));
  }, [view]);
  applyCursorRef.current = applyCursor;
  const setCursorShape = useCallback(
    (png: Uint8Array | null, xhot: number, yhot: number, width = 0, height = 0) => {
      cursorRef.current = png ? { png, xhot, yhot, width, height } : null;
      applyCursor();
      setPadCursor((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return png ? { url: URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" })), xhot, yhot, width, height } : null;
      });
    },
    [applyCursor],
  );

  // The streaming stack, rebuilt when the port changes or Retry is pressed.
  useEffect(() => {
    if (!status?.running || !status.port) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!hasWebCodecs()) {
      setError("This browser has no WebCodecs; the viewer needs a current Chrome, Edge, Firefox or Safari.");
      return;
    }
    let disposed = false;
    let renderer: Renderer | null = null;
    let decoders: CodecCap[] = [];
    let detachInput: (() => void) | null = null;
    const port = status.port;

    const conn = new Connection(port, {
      decoders: () => decoders,
      viewerId,
      onControl: (msg: Msg) => {
        if (filesRef.current?.onControl(msg)) return;
        switch (msg.t) {
          case "HelloAck":
            firstSeatRef.current = true;
            infoSeenRef.current = false;
            displayKindRef.current = -1;
            lastRequestRef.current = "";
            decoderRef.current?.reset();
            sendQuality();
            if (!active || document.hidden) conn.send({ t: "Pause", paused: true });
            canvas.focus({ preventScroll: true });
            break;
          case "StreamStarted":
            if (msg.stream !== 0) break;
            setCodec(msg.codec);
            remoteSizeRef.current = { width: msg.width, height: msg.height };
            setRemoteSize(remoteSizeRef.current);
            decoderRef.current?.reset();
            layout();
            break;
          case "DisplayInfo":
            if (msg.stream !== 0) break;
            displayKindRef.current = msg.kind;
            if (msg.note) showNotice(msg.note, 6000);
            if (!infoSeenRef.current) {
              infoSeenRef.current = true;
              requestDisplay(true);
            }
            break;
          case "CursorInfo":
            setCursorInPicture(msg.inPicture);
            if (msg.inPicture) setCursorShape(null, 0, 0);
            break;
          case "Cursor":
            setCursorShape(msg.png, msg.xhot, msg.yhot, msg.width, msg.height);
            break;
          case "Clipboard":
            if (msg.kind === ClipKind.TEXT) void clipboardRef.current.remoteText(new TextDecoder().decode(msg.data));
            else if (msg.kind === ClipKind.PNG) void clipboardRef.current.remoteImage(msg.data);
            break;
          case "HostStats":
            if (msg.stream === 0) setEncoder(msg.encoder);
            break;
          case "Error":
            if (msg.code === ERROR_BUSY) showNotice("Another client is connected to this host.", 8000);
            else if (msg.code === ERROR_REPLACED) showNotice(msg.text, 8000);
            else showNotice(msg.text, 8000);
            break;
          default:
            break;
        }
      },
      onSeat: (seat) => {
        setViewers(seat.viewers);
        setCursorInPicture(seat.cursorInPicture);
        if (seat.cursorInPicture) setCursorShape(null, 0, 0);
        applyDriver(seat.driver, seat.scalePct / 100, seat.driverRatioPct / 100);
        // A driver that lost its seat to a reconnect (a Perch restart, a
        // network blip) takes it back: judged on the first seat after the
        // connection opened, never on a later hand-over to another tab.
        const first = firstSeatRef.current;
        firstSeatRef.current = false;
        if (first && !seat.driver && wasDriverRef.current) conn.claim();
      },
      onVideo: (frame) => {
        const { width, height } = frame.meta;
        if (width !== remoteSizeRef.current.width || height !== remoteSizeRef.current.height) {
          remoteSizeRef.current = { width, height };
          setRemoteSize(remoteSizeRef.current);
          layout();
        }
        renderer?.setSize(width, height);
        decoderRef.current?.decode(frame);
      },
      onDatagram: (payload) => {
        if (payload[0] !== Kind.AUDIO) return;
        const audio = audioRef.current;
        if (!audio) return;
        try {
          audio.push(decodeAudio(payload));
        } catch {
          // a malformed packet
        }
      },
      onFile: (chunk) => filesRef.current?.onChunk(chunk),
      onState: (state, attempt) => {
        setConnState(state);
        if (state === "reconnecting") {
          filesRef.current?.reset();
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
    filesRef.current = createFileTransfer({
      transport: { send: (m) => conn.send(m), sendFile: (c) => conn.sendFile(c), bufferedAmount: () => conn.bufferedAmount() },
      onNotice: (text) => showNotice(text, text && /^(Sent|Received|.*failed|.*damaged|.*checked|Not connected)/.test(text) ? 4000 : 0),
    });

    probeDecoders()
      .then((caps) => {
        if (disposed) return;
        decoders = caps;
        if (caps.length === 0) {
          setError("This browser's WebCodecs decodes none of AV1, H.265 or H.264.");
          return;
        }
        const decoder = createDecoder({
          onPicture: (frame, decodeMs) => {
            conn.reportDecode(decodeMs);
            if (disposed) {
              frame.close();
              return;
            }
            renderer?.draw(frame);
          },
          onNeedKeyframe: () => {
            conn.reportLost();
            conn.send({ t: "KeyframeReq", stream: 0 });
          },
        });
        decoderRef.current = decoder;
        renderer = new Renderer(canvas);
        if (!renderer.ready) {
          setError("This browser cannot draw the stream (no canvas context).");
          return;
        }
        detachInput = attachInput(canvas, {
          sendInput: (e) => conn.sendInput(e),
          sendClipboard: (kind, data) => conn.send({ t: "Clipboard", kind, data }),
          view,
          onClipboardTruncated: () => showNotice("Pasted text was cut at 16 MB."),
          keepFocus: () => kbRef.current?.isOpen() ?? false,
          toggleKeyboard: () => kbRef.current?.toggle(),
          touchMode: () => viewSettingsRef.current.touchMode,
          gestures: () => gesturesRef.current,
          onPointerMoved: (x, y) => {
            if (viewSettingsRef.current.touchMode === "trackpad") setPadPos({ x, y });
          },
        });
        conn.start();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));

    const statsTimer = window.setInterval(() => {
      setStats({ ...conn.stats });
      setAudioPackets(audioRef.current?.packets ?? 0);
    }, STATS_REFRESH_MS);

    return () => {
      disposed = true;
      window.clearInterval(statsTimer);
      detachInput?.();
      conn.stop();
      decoderRef.current?.close();
      decoderRef.current = null;
      filesRef.current = null;
      connectionRef.current = null;
      setCursorShape(null, 0, 0);
      if (requestTimerRef.current !== null) {
        window.clearTimeout(requestTimerRef.current);
        requestTimerRef.current = null;
      }
    };
    // `active` is handled by the pause effect below; rebuilding on it would
    // reconnect on every tab switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.running, status?.port, generation]);

  // The phone keyboard follows its field: mounted on touch devices, which
  // a tab may become after the stream started (a laptop's touch screen,
  // a browser whose pointer type changes), so it is attached on its own.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const kb = attachPhoneKeyboard({
      field,
      send: (e) => connectionRef.current?.sendInput(e),
      onOpenChange: (open) => {
        kbOpenRef.current = open;
        setKbOpen(open);
        if (!open) {
          // Back to the tab's full height, and the desktop follows it.
          layout();
          requestDisplay();
        }
      },
      onArmedChange: (armed, locked) => {
        setArmedKeys(armed);
        setLockedKeys(locked);
      },
    });
    kbRef.current = kb;
    return () => {
      kb.detach();
      if (kbRef.current === kb) kbRef.current = null;
    };
  }, [touch, layout, requestDisplay]);

  // Pause while nobody can see the tab.
  useEffect(() => {
    const conn = connectionRef.current;
    if (!conn || conn.state !== "open") return;
    conn.send({ t: "Pause", paused: !(active && !docHidden) });
    if (active && !docHidden && !kbRef.current?.isOpen()) canvasRef.current?.focus({ preventScroll: true });
  }, [active, docHidden, connState]);

  // A hidden tab has no business holding the phone keyboard open.
  useEffect(() => {
    if (!active && kbRef.current?.isOpen()) kbRef.current.toggle();
  }, [active]);

  // Audio: the pipe is made inside a click (browsers want a gesture). A
  // browser that had it on gets it back on the first press in the tab.
  useEffect(() => {
    if (!viewSettings.audio || audioRef.current || !AudioPipe.supported()) return;
    const el = hostRef.current;
    if (!el) return;
    const arm = () => {
      if (!audioRef.current && viewSettingsRef.current.audio) {
        audioRef.current = new AudioPipe();
        setAudioOn(true);
      }
    };
    el.addEventListener("pointerdown", arm, { once: true });
    el.addEventListener("keydown", arm, { once: true });
    return () => {
      el.removeEventListener("pointerdown", arm);
      el.removeEventListener("keydown", arm);
    };
  }, [viewSettings.audio, status?.running]);

  useEffect(
    () => () => {
      audioRef.current?.close();
      audioRef.current = null;
    },
    [],
  );

  const toggleAudio = () => {
    if (audioRef.current) {
      audioRef.current.close();
      audioRef.current = null;
      setAudioOn(false);
      applyViewSettings({ audio: false });
      return;
    }
    if (!AudioPipe.supported()) {
      showNotice("This browser cannot decode the desktop's audio (no WebCodecs AudioDecoder).");
      return;
    }
    audioRef.current = new AudioPipe();
    audioRef.current.resume();
    setAudioOn(true);
    applyViewSettings({ audio: true });
  };

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

  // Dragging the fullscreen controls. Pointer capture starts only once the
  // move passes the threshold: captured earlier, the click would land on
  // the container instead of the button that was tapped.
  const onFsPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Keeps focus where it is (the phone keyboard's field stays open).
    e.preventDefault();
    const el = fsControlsRef.current;
    const host = hostRef.current;
    if (!el || !host) return;
    // Where it is on screen, not offsetLeft/Top: those ignore the
    // translate that places it.
    const box = el.getBoundingClientRect();
    const hostBox = host.getBoundingClientRect();
    fsDragRef.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left: box.left - hostBox.left,
      top: box.top - hostBox.top,
      dragging: false,
    };
  };
  const onFsPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = fsDragRef.current;
    const el = fsControlsRef.current;
    const host = hostRef.current;
    if (!drag || drag.id !== e.pointerId || !el || !host) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      el.setPointerCapture(e.pointerId);
    }
    const freeX = Math.max(1, host.clientWidth - el.offsetWidth);
    const freeY = Math.max(1, host.clientHeight - el.offsetHeight);
    const left = Math.min(freeX, Math.max(0, drag.left + dx));
    const top = Math.min(freeY, Math.max(0, drag.top + dy));
    setFsPos({ x: left / freeX, y: top / freeY });
  };
  const onFsPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = fsDragRef.current;
    if (!drag || drag.id !== e.pointerId) return;
    fsDragRef.current = null;
    if (!drag.dragging) return;
    // The click that ends a drag is not a tap on a button.
    fsSuppressClickRef.current = true;
    window.setTimeout(() => (fsSuppressClickRef.current = false), 0);
    setFsControlsPos(fsPosRef.current);
  };

  const takeOver = () => {
    wasDriverRef.current = true;

    connectionRef.current?.claim();
  };

  const copyPending = async () => {
    const ok = await clipboardRef.current.copyPending();
    showNotice(ok ? "Copied the desktop's clipboard." : "The browser refused the clipboard write.");
  };

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
  };
  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) void filesRef.current?.offer(f);
  };

  const zoomTo = (z: number) => {
    view.setZoom(z);
    canvasRef.current?.focus({ preventScroll: true });
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
              ref={viewButtonRef}
              data-menu-trigger="true"
              aria-haspopup="dialog"
              aria-expanded={showView}
              className={`rd-tool${showView ? " rd-tool-on" : ""}`}
              title="View settings for this device: size, pixel ratio, view, zoom, quality"
              onClick={() => setShowView((v) => !v)}
            >
              <Icon name="settings" />
            </button>
            <button
              className={`rd-tool${audioOn ? " rd-tool-on" : ""}`}
              title={audioOn ? "Mute the desktop's audio" : "Play the desktop's audio"}
              aria-pressed={audioOn}
              onClick={toggleAudio}
            >
              <Icon name={audioOn ? "unmute" : "mute"} />
            </button>
            {touch && (
              <button
                className={`rd-tool${kbOpen ? " rd-tool-on" : ""}`}
                title={kbOpen ? "Close the phone keyboard" : "Open the phone keyboard"}
                aria-pressed={kbOpen}
                // Taking focus from the field would close the phone keyboard
                // before the click could.
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => kbRef.current?.toggle()}
              >
                <Icon name="keyboard" />
              </button>
            )}
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

  const presetKey = `${viewSettings.fixedW}x${viewSettings.fixedH}`;
  const presetValue = PRESETS.some(([w, h]) => `${w}x${h}` === presetKey) ? presetKey : "custom";

  return (
    <div
      ref={hostRef}
      className={`rd-view-host${isFullscreen ? " rd-view-fullscreen" : ""}${cursorInPicture ? " rd-view-cursor-remote" : ""}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {toolbar}
      <canvas
        key={generation}
        ref={canvasRef}
        // In fullscreen every key belongs to the desktop: Perch's own
        // shortcuts stand down (core honours this attribute) and Keyboard
        // Lock takes the browser's. Outside fullscreen the app keeps them.
        data-keyboard-capture="fullscreen"
        className="rd-view-canvas"
        tabIndex={0}
        style={canvasBox ? { left: canvasBox.left, top: canvasBox.top, width: canvasBox.width, height: canvasBox.height } : { left: 0, top: 0, width: "100%", height: "100%" }}
      />
      {touch && viewSettings.touchMode === "trackpad" && padPos && padCursor && !cursorInPicture && (
        <img
          className="rd-view-pad-cursor"
          src={padCursor.url}
          alt=""
          draggable={false}
          style={{
            left: view.x + padPos.x * view.scale - padCursor.xhot / (view.ratio || 1),
            top: view.y + padPos.y * view.scale - padCursor.yhot / (view.ratio || 1),
            width: padCursor.width / (view.ratio || 1),
            height: padCursor.height / (view.ratio || 1),
          }}
        />
      )}
      <textarea
        ref={fieldRef}
        className="rd-kb-field"
        aria-label="Type on the desktop"
        // Chords from a paired hardware keyboard belong to the desktop while
        // the phone keyboard is open, not to Perch's shortcuts.
        data-keyboard-capture="always"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        rows={1}
      />
      {isFullscreen && touch && (
        // Perch's toolbar is outside the fullscreen element, so a phone
        // gets its two controls here.
        <div
          ref={fsControlsRef}
          className="rd-fs-controls"
          // The spot is a fraction of the free space: at 0 the left (top)
          // edge, at 1 flush with the right (bottom) edge.
          style={{
            left: `${fsPos.x * 100}%`,
            top: `${fsPos.y * 100}%`,
            transform: `translate(${-fsPos.x * 100}%, ${-fsPos.y * 100}%)`,
          }}
          onPointerDown={onFsPointerDown}
          onPointerMove={onFsPointerMove}
          onPointerUp={onFsPointerEnd}
          onPointerCancel={onFsPointerEnd}
          onMouseDown={(e) => e.preventDefault()}
          onClickCapture={(e) => {
            if (!fsSuppressClickRef.current) return;
            fsSuppressClickRef.current = false;
            e.stopPropagation();
            e.preventDefault();
          }}
        >
          <span className="rd-fs-grip" title="Drag to move" aria-hidden="true">
            <Icon name="gripper" />
          </span>
          <button
            type="button"
            className={`rd-fs-control${kbOpen ? " rd-fs-control-on" : ""}`}
            title={kbOpen ? "Close the phone keyboard" : "Open the phone keyboard"}
            aria-pressed={kbOpen}
            onClick={() => kbRef.current?.toggle()}
          >
            <Icon name="keyboard" />
          </button>
          <button type="button" className="rd-fs-control" title="Exit fullscreen" onClick={() => void toggleFullscreen()}>
            <Icon name="screen-normal" />
          </button>
        </div>
      )}
      {kbOpen && (
        <div
          ref={stripRef}
          className="rd-keys"
          style={kbInset ? { bottom: kbInset } : undefined}
          role="toolbar"
          aria-label="Extra keys"
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
        >
          {chunk(stripKeys(gestures), gestures.keyRows).map((row, i) => (
            <div key={i} className="rd-keys-row">
              {row.map((k) => (
                <StripButton
                  key={k.id}
                  k={k}
                  armed={armedKeys.has(k.code)}
                  locked={lockedKeys.has(k.code)}
                  kb={() => kbRef.current}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      {connState === "connecting" && <div className="rd-view-overlay">Connecting…</div>}
      {connState === "reconnecting" && <div className="rd-view-overlay rd-view-overlay-soft">Connection lost, reconnecting…</div>}
      {showView && (
        <AnchoredPopover anchorRef={viewButtonRef} onClose={closeView} label="View settings for this device" className="rd-popover">
          <div className="rd-popover-section">
            <div className="rd-popover-title">Size{isDriver ? "" : " (applies when this tab drives)"}</div>
            <label className="rd-popover-option">
              <input type="radio" name="rd-size" checked={viewSettings.sizeMode === "follow"} onChange={() => applyViewSettings({ sizeMode: "follow" })} />
              <span>Follow the tab</span>
            </label>
            <label className="rd-popover-option">
              <input type="radio" name="rd-size" checked={viewSettings.sizeMode === "fixed"} onChange={() => applyViewSettings({ sizeMode: "fixed" })} />
              <span>Fixed resolution</span>
              <span className="rd-popover-hint">{viewSettings.fixedW}x{viewSettings.fixedH}</span>
            </label>
            <div className="rd-popover-row">
              <select
                className="rd-select"
                aria-label="Resolution preset"
                value={presetValue}
                onChange={(e) => {
                  if (e.target.value === "custom") return;
                  const [w, h] = e.target.value.split("x").map(Number);
                  applyViewSettings({ sizeMode: "fixed", fixedW: w, fixedH: h });
                }}
              >
                {PRESETS.map(([w, h]) => (
                  <option key={`${w}x${h}`} value={`${w}x${h}`}>
                    {w}x{h}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
              <select className="rd-select" aria-label="Refresh rate" value={viewSettings.hz} onChange={(e) => applyViewSettings({ hz: Number(e.target.value) })}>
                {RATES.map((r) => (
                  <option key={r} value={r}>
                    {r} Hz
                  </option>
                ))}
              </select>
            </div>
            <div className="rd-popover-row">
              <input
                className="rd-input rd-input-size"
                aria-label="Custom width"
                placeholder="width"
                inputMode="numeric"
                value={customSize.w}
                onChange={(e) => setCustomSize({ ...customSize, w: e.target.value })}
              />
              <span className="rd-popover-x">x</span>
              <input
                className="rd-input rd-input-size"
                aria-label="Custom height"
                placeholder="height"
                inputMode="numeric"
                value={customSize.h}
                onChange={(e) => setCustomSize({ ...customSize, h: e.target.value })}
              />
              <button className="rd-btn rd-btn-small" type="button" onClick={applyCustomSize} disabled={!customSize.w || !customSize.h}>
                Apply
              </button>
            </div>
          </div>
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
          {touch && (
            <div className="rd-popover-section">
              <div className="rd-popover-title">Touch</div>
              {(
                [
                  ["direct", "Direct", "the pointer goes where you touch"],
                  ["trackpad", "Trackpad", "one finger moves the pointer; tap to click, tap twice and hold to drag"],
                ] as [TouchMode, string, string][]
              ).map(([mode, label, hint]) => (
                <label key={mode} className="rd-popover-option">
                  <input type="radio" name="rd-touch" checked={viewSettings.touchMode === mode} onChange={() => applyViewSettings({ touchMode: mode })} />
                  <span>{label}</span>
                  <span className="rd-popover-hint">{hint}</span>
                </label>
              ))}
            </div>
          )}
          <GestureSections g={gestures} touch={touch} apply={applyGestures} />
          <div className="rd-popover-section">
            <div className="rd-popover-title">View</div>
            {(
              [
                ["fit", "Fit", "shrinks a large picture, never enlarges"],
                ["fill", "Fill the tab", "fills the tab, aspect ratio kept"],
                ["native", "100%", "one remote pixel per device pixel"],
              ] as [ViewMode, string, string][]
            ).map(([mode, label, hint]) => (
              <label key={mode} className="rd-popover-option">
                <input type="radio" name="rd-view" checked={viewSettings.view === mode} onChange={() => applyViewSettings({ view: mode })} />
                <span>{label}</span>
                <span className="rd-popover-hint">{hint}</span>
              </label>
            ))}
          </div>
          <div className="rd-popover-section">
            <div className="rd-popover-title">Zoom</div>
            <div className="rd-popover-row rd-popover-zoom">
              <button className="rd-btn" title="Zoom out" disabled={zoomPct <= ZOOM_MIN * 100} onClick={() => zoomTo(view.zoom / 1.25)}>
                <Icon name="zoom-out" />
              </button>
              <button className="rd-btn" title="Back to 100%" onClick={() => zoomTo(1)}>
                {zoomPct}%
              </button>
              <button className="rd-btn" title="Zoom in" disabled={zoomPct >= ZOOM_MAX * 100} onClick={() => zoomTo(view.zoom * 1.25)}>
                <Icon name="zoom-in" />
              </button>
            </div>
            <label className="rd-popover-option">
              <input type="checkbox" checked={viewSettings.lockZoom} onChange={(e) => applyViewSettings({ lockZoom: e.target.checked })} />
              <span>Lock zoom</span>
              <span className="rd-popover-hint">a pinch or Ctrl+wheel changes nothing; the buttons still do</span>
            </label>
          </div>
          <div className="rd-popover-section">
            <div className="rd-popover-title">Quality</div>
            {(
              [
                ["high", "High", "full bit budget"],
                ["medium", "Medium", "40%"],
                ["low", "Low", "15%, smoothest on a weak link"],
              ] as [Quality, string, string][]
            ).map(([q, label, hint]) => (
              <label key={q} className="rd-popover-option">
                <input type="radio" name="rd-quality" checked={viewSettings.quality === q} onChange={() => applyViewSettings({ quality: q })} />
                <span>{label}</span>
                <span className="rd-popover-hint">{hint}</span>
              </label>
            ))}
          </div>
          <div className="rd-popover-footer">
            {isDriver
              ? `This tab drives: the desktop follows its ${viewSettings.sizeMode === "fixed" ? "fixed resolution" : "size"} at ${pixelRatio}x.`
              : `Following another viewer at ${desktopScale}x; the view and zoom only change how this tab shows its picture.`}
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
            {remoteSize.width}x{remoteSize.height} @ {pixelRatio.toFixed(2)}x, {codec !== null ? codecLabel(codec) : "no stream"} via WebCodecs
            {encoder ? ` from ${encoder}` : ""}, {isDriver ? "driver" : `follower of ${desktopScale}x`}
          </div>
          <div>
            {stats ? `${stats.fps.toFixed(1)} fps, ${Math.round(stats.kbps)} kbps, rtt ${stats.rttMs.toFixed(0)} ms` : "no stats yet"}
          </div>
          <div>{stats ? `decode ${stats.decodeMs.toFixed(1)} ms, lost ${stats.lost}, viewers ${viewers}, zoom ${zoomPct}%` : ""}</div>
          <div>{audioOn ? `audio on, ${audioPackets} packets` : "audio off"}{cursorInPicture ? ", cursor in picture" : ""}</div>
        </div>
      )}
    </div>
  );
}

/** The strip's keys in `rows` rows of about equal length. */
function chunk(keys: StripKey[], rows: number): StripKey[][] {
  const per = Math.max(1, Math.ceil(keys.length / Math.max(1, Math.min(rows, keys.length))));
  const out: StripKey[][] = [];
  for (let i = 0; i < keys.length; i += per) out.push(keys.slice(i, i + per));
  return out;
}

/**
 * One key on the strip. A modifier arms on a tap (for the next key) and
 * locks on a long press until tapped again; any other key goes down on
 * press and up on release, so the desktop repeats it while held.
 */
function StripButton({ k, armed, locked, kb }: { k: StripKey; armed: boolean; locked: boolean; kb: () => PhoneKeyboard | null }) {
  const timer = useRef<number | null>(null);
  const long = useRef(false);
  const down = useRef(false);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const release = () => {
    clear();
    if (down.current) {
      down.current = false;
      kb()?.pressStripKey(k.code, false);
    }
  };
  return (
    <button
      type="button"
      className={`rd-key${locked ? " rd-key-locked" : ""}`}
      aria-label={k.title ?? k.label}
      aria-pressed={k.modifier ? armed : undefined}
      onPointerDown={() => {
        long.current = false;
        if (k.modifier) {
          timer.current = window.setTimeout(() => {
            timer.current = null;
            long.current = true;
            kb()?.lockStripKey(k.code);
          }, 500);
        } else {
          down.current = true;
          kb()?.pressStripKey(k.code, true);
        }
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      onClick={(e) => {
        if (k.modifier) {
          if (!long.current) kb()?.tapStripKey(k.code);
        } else if (e.detail === 0) kb()?.tapStripKey(k.code); // Enter or Space on a focused key
      }}
    >
      {k.label}
    </button>
  );
}

/** Gestures, trackpad, scrolling and the keys strip, in the View popover. */
function GestureSections({ g, touch, apply }: { g: GestureSettings; touch: boolean; apply: (next: Partial<GestureSettings>) => void }) {
  const select = (label: string, value: Action, options: Action[], on: (a: Action) => void) => (
    <label className="rd-popover-option rd-popover-select">
      <span>{label}</span>
      <select className="rd-select" value={value} onChange={(e) => on(e.target.value as Action)}>
        {options.map((a) => (
          <option key={a} value={a}>
            {ACTION_LABEL[a]}
          </option>
        ))}
      </select>
    </label>
  );
  const range = (label: string, value: number, on: (v: number) => void) => (
    <label className="rd-popover-option rd-popover-select">
      <span>{label}</span>
      <input type="range" min={0.5} max={2} step={0.1} value={value} onChange={(e) => on(Number(e.target.value))} />
      <span className="rd-popover-hint">{value.toFixed(1)}x</span>
    </label>
  );
  const move = (i: number, d: number) => {
    const keys = [...g.keys];
    keys.splice(i + d, 0, keys.splice(i, 1)[0]);
    apply({ keys });
  };
  return (
    <>
      {touch && (
        <details className="rd-popover-section">
          <summary className="rd-popover-title">Gestures</summary>
          {select("Double tap", g.doubleTap, TAP_ACTIONS, (a) => apply({ doubleTap: a }))}
          {select("Long press", g.longPress, [...TAP_ACTIONS, "drag"], (a) => apply({ longPress: a }))}
          {select("Two-finger tap", g.twoTap, TAP_ACTIONS, (a) => apply({ twoTap: a }))}
          {select("Three-finger tap", g.threeTap, TAP_ACTIONS, (a) => apply({ threeTap: a }))}
          {select("Four-finger tap", g.fourTap, TAP_ACTIONS, (a) => apply({ fourTap: a }))}
          {select("Tap, then touch and move", g.tapDrag, ["drag", "none"], (a) => apply({ tapDrag: a }))}
          <label className="rd-popover-option">
            <input type="checkbox" checked={g.acceleration} onChange={(e) => apply({ acceleration: e.target.checked })} />
            <span>Pointer acceleration</span>
            <span className="rd-popover-hint">trackpad: slow moves are precise, fast moves go far</span>
          </label>
          {range("Pointer speed", g.speed, (v) => apply({ speed: v }))}
          {range("Sensitivity", g.sensitivity, (v) => apply({ sensitivity: v }))}
        </details>
      )}
      <details className="rd-popover-section">
        <summary className="rd-popover-title">Scrolling and mouse</summary>
        <label className="rd-popover-option">
          <input type="checkbox" checked={g.invertScroll} onChange={(e) => apply({ invertScroll: e.target.checked })} />
          <span>Invert vertical scrolling</span>
        </label>
        <label className="rd-popover-option rd-popover-select">
          <span>Mouse Back button</span>
          <select className="rd-select" value={g.back} onChange={(e) => apply({ back: e.target.value as GestureSettings["back"] })}>
            <option value="back">Back</option>
            <option value="right">Right click</option>
            <option value="middle">Middle click</option>
          </select>
        </label>
      </details>
      {touch && (
        <details className="rd-popover-section">
          <summary className="rd-popover-title">Keys strip</summary>
          <label className="rd-popover-option rd-popover-select">
            <span>Rows</span>
            <select className="rd-select" value={g.keyRows} onChange={(e) => apply({ keyRows: Number(e.target.value) })}>
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <ol className="rd-keys-editor">
            {g.keys.map((id, i) => {
              const k = STRIP_KEYS.find((x) => x.id === id);
              if (!k) return null;
              return (
                <li key={id}>
                  <span>{k.title ?? k.label}</span>
                  <button type="button" className="rd-btn" aria-label={`Move ${k.label} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className="rd-btn" aria-label={`Move ${k.label} down`} disabled={i === g.keys.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button type="button" className="rd-btn" aria-label={`Remove ${k.label}`} disabled={g.keys.length <= 1} onClick={() => apply({ keys: g.keys.filter((x) => x !== id) })}>
                    ×
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="rd-popover-row">
            <select className="rd-select" value="" aria-label="Add a key" onChange={(e) => e.target.value && apply({ keys: [...g.keys, e.target.value] })}>
              <option value="">Add a key…</option>
              {STRIP_KEYS.filter((k) => !g.keys.includes(k.id)).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.title ?? k.label}
                </option>
              ))}
            </select>
            <button type="button" className="rd-btn" onClick={() => apply({ keys: DEFAULT_KEYS, keyRows: 1 })}>
              Reset
            </button>
          </div>
        </details>
      )}
    </>
  );
}
