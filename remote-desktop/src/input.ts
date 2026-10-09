// Keyboard, pointer, wheel, touch and paste capture on the viewer canvas,
// turned into QuickRemote input events. Keys travel by physical position
// (keymap.ts); a paste shortcut waits for the paste event so the clipboard
// reaches the host before the keystroke does. Ctrl+wheel and a pinch zoom
// the view; two fingers pan a zoomed picture (or scroll otherwise); a
// mouse near the stage's edge pans a zoomed picture.
import { evdevForCode } from "./keymap";
import { ClipKind, type InputEvent } from "./qr/proto";
import { clipClipboardText } from "./wire";
import type { View } from "./view";

export interface InputTarget {
  sendInput(e: InputEvent): void;
  sendClipboard(kind: number, data: Uint8Array): void;
  view: View;
  onClipboardTruncated(): void;
  /** True while another element (the phone keyboard's field) must keep
   * focus when the canvas is tapped. */
  keepFocus?(): boolean;
  /** A four-finger tap: open or close the phone keyboard. */
  toggleKeyboard?(): void;
  /** How one finger drives the pointer on a touch screen. */
  touchMode?(): "direct" | "trackpad";
  /** The pointer moved to this remote pixel (for drawing it in trackpad mode). */
  onPointerMoved?(x: number, y: number): void;
}

// Wheel: 1/120-notch units, positive up and right, as the protocol wants.
const WHEEL_PIXEL = 1.2;
const WHEEL_LINE = 120;
const WHEEL_PAGE = 1200;
const WHEEL_MAX = 32767;
// How long a Ctrl+V keydown waits for its paste event before it is sent
// anyway (an empty clipboard fires no paste event).
const PASTE_WAIT_MS = 150;
// A zoomed picture pans when the mouse is this close to the stage's edge.
const EDGE_PX = 32;
const EDGE_SPEED = 12;
// Two fingers move this far before the gesture counts as a pan or scroll.
const GESTURE_SLOP_PX = 10;
// A finger held still this long is a right click; a tap must end within
// TAP_MS; a second tap within DOUBLE_TAP_MS and DOUBLE_TAP_PX of the first
// lands on the same remote pixel, so the desktop sees a double click.
const LONG_PRESS_MS = 500;
const TAP_MS = 500;
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 40;
// Trackpad mode: remote pixels per CSS pixel of finger travel at 100%.
const TRACKPAD_GAIN = 1.5;
// Scroll from a two-finger drag: CSS pixels per notch.
const TOUCH_SCROLL_PX = 40;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

// Macs have no Control key where a Linux desktop expects one; Command is
// the key people press for copy, paste and shortcuts, so it lands as Control.
function physicalCode(code: string): string {
  if (!isMac) return code;
  if (code === "MetaLeft") return "ControlLeft";
  if (code === "MetaRight") return "ControlRight";
  return code;
}

// Modifier flag on a key event, with the physical keys that set it.
const MODIFIERS: Array<[keyof Pick<KeyboardEvent, "shiftKey" | "ctrlKey" | "altKey" | "metaKey">, string, string]> = [
  ["shiftKey", "ShiftLeft", "ShiftRight"],
  ["ctrlKey", "ControlLeft", "ControlRight"],
  ["altKey", "AltLeft", "AltRight"],
  ["metaKey", "MetaLeft", "MetaRight"],
];

interface Finger {
  x: number;
  y: number;
  x0: number;
  y0: number;
}

export function attachInput(canvas: HTMLCanvasElement, target: InputTarget): () => void {
  const { view } = target;
  const held = new Set<number>();
  const pressedButtons = new Set<number>();
  // Modifiers the remote holds on our behalf because an event carried the
  // flag without the key ever going down here (Shift pressed before the
  // canvas had focus, synthetic input): released when the flag clears.
  const implied = new Set<number>();
  let pendingMove: { x: number; y: number } | null = null;
  let moveFrame: number | null = null;
  let pasteTimer: number | null = null;
  let pasteKey: number | null = null;
  // Touch gestures: tap = left click, long press = right click, one-finger
  // drag = left drag, two-finger tap = right click, two-finger drag =
  // scroll (pan while zoomed in), pinch = zoom, three-finger tap = middle
  // click, four-finger tap = keyboard.
  const fingers = new Map<number, Finger>();
  let touchStarted = 0;
  let maxFingers = 0;
  let touchMoved = false;
  let dragging = false;
  let longTimer: number | null = null;
  let longFired = false;
  let pinch: { dist: number; mx: number; my: number } | null = null;
  const scrollAcc = { x: 0, y: 0 };
  let lastTap: { t: number; x: number; y: number } | null = null;
  // Trackpad mode: where the pointer is (remote pixels), and whether the
  // finger down now came right after a tap (a double-tap-and-hold drags).
  let pad: { x: number; y: number } | null = null;
  let padDragArmed = false;
  const trackpad = () => target.touchMode?.() === "trackpad";
  const padPosition = () => {
    if (!pad) pad = { x: Math.floor(view.picture.width / 2), y: Math.floor(view.picture.height / 2) };
    pad.x = Math.max(0, Math.min(Math.max(0, view.picture.width - 1), pad.x));
    pad.y = Math.max(0, Math.min(Math.max(0, view.picture.height - 1), pad.y));
    return pad;
  };
  const padMoveBy = (dx: number, dy: number) => {
    const p = padPosition();
    const k = TRACKPAD_GAIN / (view.scale || 1);
    p.x += dx * k;
    p.y += dy * k;
    const q = padPosition();
    const pos = { x: Math.floor(q.x), y: Math.floor(q.y) };
    pendingMove = pos;
    if (moveFrame === null) moveFrame = requestAnimationFrame(flushMove);
  };
  const padClick = (button: number) => {
    const q = padPosition();
    pendingMove = { x: Math.floor(q.x), y: Math.floor(q.y) };
    flushMove();
    sendButton(button, true);
    sendButton(button, false);
  };
  // Edge panning with the mouse.
  let panVel = [0, 0];
  let panning = false;

  const sendKey = (code: number, down: boolean) => {
    if (down) held.add(code);
    else held.delete(code);
    target.sendInput({ t: "Key", code, down });
  };

  const sendButton = (button: number, down: boolean) => {
    if (down) pressedButtons.add(button);
    else pressedButtons.delete(button);
    target.sendInput({ t: "Button", button, down });
  };

  // Bring the remote's modifier state in line with the event's flags.
  const syncModifiers = (e: KeyboardEvent) => {
    for (const [flag, left, right] of MODIFIERS) {
      const leftCode = evdevForCode(physicalCode(left));
      const rightCode = evdevForCode(physicalCode(right));
      if (leftCode === undefined || rightCode === undefined) continue;
      const active = e[flag];
      const downHere = held.has(leftCode) || held.has(rightCode);
      if (active && !downHere) {
        implied.add(leftCode);
        sendKey(leftCode, true);
      } else if (!active && implied.has(leftCode)) {
        implied.delete(leftCode);
        sendKey(leftCode, false);
      }
    }
  };

  const releaseAll = () => {
    cancelLong();
    fingers.clear();
    dragging = false;
    pinch = null;
    implied.clear();
    for (const code of held) target.sendInput({ t: "Key", code, down: false });
    held.clear();
    for (const button of pressedButtons) target.sendInput({ t: "Button", button, down: false });
    pressedButtons.clear();
    target.sendInput({ t: "ReleaseAll" });
  };

  const flushPendingPasteKey = () => {
    if (pasteTimer !== null) {
      window.clearTimeout(pasteTimer);
      pasteTimer = null;
    }
    if (pasteKey !== null) {
      sendKey(pasteKey, true);
      pasteKey = null;
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const code = evdevForCode(physicalCode(e.code));
    if (code === undefined) return;
    if (!MODIFIERS.some(([, l, r]) => e.code === l || e.code === r)) syncModifiers(e);
    const shortcut = isMac ? e.metaKey : e.ctrlKey;
    if (shortcut && e.code === "KeyV" && !e.altKey) {
      // Let the browser fire `paste` so the clipboard goes first; the
      // keydown follows from the paste handler or the timeout.
      if (pasteKey === null) {
        pasteKey = code;
        pasteTimer = window.setTimeout(flushPendingPasteKey, PASTE_WAIT_MS);
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && held.has(code)) return; // the remote autorepeats
    sendKey(code, true);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const code = evdevForCode(physicalCode(e.code));
    if (code === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (pasteKey === code) flushPendingPasteKey();
    sendKey(code, false);
    if (!MODIFIERS.some(([, l, r]) => e.code === l || e.code === r)) syncModifiers(e);
  };

  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const items = Array.from(e.clipboardData?.items ?? []);
    const image = items.find((i) => i.kind === "file" && i.type === "image/png")?.getAsFile();
    if (image) {
      image
        .arrayBuffer()
        .then((buf) => target.sendClipboard(ClipKind.PNG, new Uint8Array(buf)))
        .finally(flushPendingPasteKey);
      return;
    }
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text) {
      const clipped = clipClipboardText(text);
      target.sendClipboard(ClipKind.TEXT, new TextEncoder().encode(clipped.text));
      if (clipped.truncated) target.onClipboardTruncated();
    }
    flushPendingPasteKey();
  };

  const flushMove = () => {
    moveFrame = null;
    if (!pendingMove) return;
    target.sendInput({ t: "Abs", stream: 0, x: pendingMove.x, y: pendingMove.y });
    pad = { x: pendingMove.x, y: pendingMove.y };
    target.onPointerMoved?.(pendingMove.x, pendingMove.y);
    pendingMove = null;
  };

  const queueMove = (clientX: number, clientY: number) => {
    // A drag that leaves the picture keeps reporting its edge.
    const pos = pressedButtons.size ? view.toRemoteClamped(clientX, clientY) : view.toRemote(clientX, clientY);
    if (!pos) return;
    pendingMove = pos;
    if (moveFrame === null) moveFrame = requestAnimationFrame(flushMove);
  };

  const protocolButton = (button: number): number | null => {
    switch (button) {
      case 0:
        return 1;
      case 1:
        return 2;
      case 2:
        return 3;
      case 3:
        return 4;
      case 4:
        return 5;
      default:
        return null;
    }
  };

  // While zoomed in, the picture follows the mouse near the stage's edges.
  const edgePan = (e: PointerEvent) => {
    if (e.pointerType === "touch" || !view.pans()) {
      panVel = [0, 0];
      return;
    }
    const r = view.stageBox();
    const v = (p: number, lo: number, hi: number) => (p < lo + EDGE_PX ? EDGE_SPEED : p > hi - EDGE_PX ? -EDGE_SPEED : 0);
    panVel = [v(e.clientX, r.left, r.left + r.width), v(e.clientY, r.top, r.top + r.height)];
    if ((panVel[0] || panVel[1]) && !panning) {
      panning = true;
      const step = () => {
        if (!panVel[0] && !panVel[1]) {
          panning = false;
          return;
        }
        view.panBy(panVel[0], panVel[1]);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  };


  const cancelLong = () => {
    if (longTimer !== null) {
      window.clearTimeout(longTimer);
      longTimer = null;
    }
  };
  const fingerMid = () => {
    const a = [...fingers.values()];
    return { x: a.reduce((s, f) => s + f.x, 0) / a.length, y: a.reduce((s, f) => s + f.y, 0) / a.length };
  };
  const fingerSpread = () => {
    const [a, b] = [...fingers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const click = (button: number, x: number, y: number) => {
    queueMove(x, y);
    flushMove();
    sendButton(button, true);
    sendButton(button, false);
  };
  // Where a tap lands: on the previous tap's spot when it comes right
  // after it, so two taps make one double click however the finger moved.
  const tapPoint = (f: Finger) => {
    const now = performance.now();
    if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(f.x0 - lastTap.x, f.y0 - lastTap.y) < DOUBLE_TAP_PX) {
      lastTap = { t: now, x: lastTap.x, y: lastTap.y };
    } else {
      lastTap = { t: now, x: f.x0, y: f.y0 };
    }
    return lastTap;
  };

  const onTouchDown = (e: PointerEvent) => {
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // untracked pointer
    }
    if (fingers.size === 0) {
      touchStarted = performance.now();
      maxFingers = 0;
      touchMoved = false;
      longFired = false;
      dragging = false;
      pinch = null;
      scrollAcc.x = 0;
      scrollAcc.y = 0;
    }
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    maxFingers = Math.max(maxFingers, fingers.size);
    cancelLong();
    if (fingers.size === 1) {
      const f = fingers.get(e.pointerId)!;
      if (trackpad()) {
        padDragArmed = lastTap !== null && performance.now() - lastTap.t < DOUBLE_TAP_MS;
      } else {
        queueMove(f.x, f.y);
      }
      longTimer = window.setTimeout(() => {
        longTimer = null;
        if (touchMoved || fingers.size !== 1) return;
        longFired = true;
        if (trackpad()) padClick(3);
        else click(3, f.x0, f.y0);
      }, LONG_PRESS_MS);
    } else if (fingers.size === 2) {
      if (dragging) {
        sendButton(1, false);
        dragging = false;
      }
      const m = fingerMid();
      pinch = { dist: fingerSpread(), mx: m.x, my: m.y };
    }
  };

  const onTouchMove = (e: PointerEvent) => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    e.preventDefault();
    f.x = e.clientX;
    f.y = e.clientY;
    if (Math.hypot(f.x - f.x0, f.y - f.y0) > GESTURE_SLOP_PX) touchMoved = true;
    if (fingers.size === 1 && touchMoved && !longFired && maxFingers === 1 && trackpad()) {
      cancelLong();
      const px = (f as Finger & { px?: number; py?: number }).px ?? f.x0;
      const py = (f as Finger & { px?: number; py?: number }).py ?? f.y0;
      if (padDragArmed && !dragging) {
        // Tap, then touch again and move: the second touch holds the
        // button down where the pointer is (the tap already clicked).
        const q = padPosition();
        pendingMove = { x: Math.floor(q.x), y: Math.floor(q.y) };
        flushMove();
        sendButton(1, true);
        dragging = true;
      }
      padMoveBy(f.x - px, f.y - py);
      (f as Finger & { px?: number; py?: number }).px = f.x;
      (f as Finger & { px?: number; py?: number }).py = f.y;
    } else if (fingers.size === 1 && touchMoved && !longFired && maxFingers === 1) {
      cancelLong();
      if (!dragging) {
        // The drag starts where the finger first touched.
        queueMove(f.x0, f.y0);
        flushMove();
        sendButton(1, true);
        dragging = true;
      }
      queueMove(f.x, f.y);
    } else if (fingers.size === 2 && pinch) {
      const m = fingerMid();
      const d = fingerSpread();
      if (!view.zoomLocked && pinch.dist > 0 && (Math.abs(d - pinch.dist) > pinch.dist * 0.08 || view.zoom !== 1)) {
        view.setZoom(view.zoom * (d / pinch.dist), [m.x, m.y]);
      }
      const dx = m.x - pinch.mx;
      const dy = m.y - pinch.my;
      if (view.pans()) {
        view.panBy(dx, dy);
      } else {
        scrollAcc.x += dx;
        scrollAcc.y += dy;
        const nx = Math.trunc(scrollAcc.x / TOUCH_SCROLL_PX);
        const ny = Math.trunc(scrollAcc.y / TOUCH_SCROLL_PX);
        if (nx || ny) {
          scrollAcc.x -= nx * TOUCH_SCROLL_PX;
          scrollAcc.y -= ny * TOUCH_SCROLL_PX;
          target.sendInput({ t: "Wheel", dx: -nx * 120, dy: ny * 120 });
        }
      }
      pinch = { dist: d, mx: m.x, my: m.y };
    }
  };

  const onTouchUp = (e: PointerEvent) => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    fingers.delete(e.pointerId);
    e.preventDefault();
    if (fingers.size === 2) {
      const m = fingerMid();
      pinch = { dist: fingerSpread(), mx: m.x, my: m.y };
    }
    if (fingers.size > 0) return;
    cancelLong();
    if (dragging) {
      if (!trackpad()) queueMove(f.x, f.y);
      flushMove();
      sendButton(1, false);
      dragging = false;
      return;
    }
    if (touchMoved || longFired || performance.now() - touchStarted > TAP_MS) return;
    if (maxFingers === 1) {
      if (trackpad()) {
        lastTap = { t: performance.now(), x: f.x0, y: f.y0 };
        padClick(1);
      } else {
        const p = tapPoint(f);
        click(1, p.x, p.y);
      }
    } else if (maxFingers === 2) {
      if (trackpad()) padClick(3);
      else click(3, f.x0, f.y0);
    } else if (maxFingers === 3) {
      if (trackpad()) padClick(2);
      else click(2, f.x0, f.y0);
    } else {
      target.toggleKeyboard?.();
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!target.keepFocus?.()) canvas.focus({ preventScroll: true });
    if (e.pointerType === "touch") {
      onTouchDown(e);
      return;
    }
    const button = protocolButton(e.button);
    if (button === null) return;
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the browser does not track (synthetic events): no capture.
    }
    queueMove(e.clientX, e.clientY);
    flushMove();
    sendButton(button, true);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      onTouchMove(e);
      return;
    }
    edgePan(e);
    queueMove(e.clientX, e.clientY);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      onTouchUp(e);
      return;
    }
    const button = protocolButton(e.button);
    if (button === null) return;
    e.preventDefault();
    queueMove(e.clientX, e.clientY);
    flushMove();
    if (pressedButtons.has(button)) sendButton(button, false);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // Ctrl+wheel (and a trackpad pinch, which arrives as one): view zoom.
    if (e.ctrlKey) {
      if (!view.zoomLocked) view.setZoom(view.zoom * Math.exp(-e.deltaY * (e.deltaMode ? 0.1 : 0.002)), [e.clientX, e.clientY]);
      return;
    }
    if (!view.toRemote(e.clientX, e.clientY)) return;
    const k = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? WHEEL_PAGE : WHEEL_PIXEL;
    const clamp = (v: number) => Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, Math.round(v)));
    const dx = clamp(-e.deltaX * k);
    const dy = clamp(-e.deltaY * k);
    if (dx === 0 && dy === 0) return;
    target.sendInput({ t: "Wheel", dx, dy });
  };

  const onContextMenu = (e: Event) => e.preventDefault();
  const onBlur = () => releaseAll();
  const onVisibility = () => {
    if (document.hidden) releaseAll();
  };
  const onLeave = () => {
    panVel = [0, 0];
  };

  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("paste", onPaste);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    canvas.removeEventListener("keydown", onKeyDown);
    canvas.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("paste", onPaste);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContextMenu);
    canvas.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    if (moveFrame !== null) cancelAnimationFrame(moveFrame);
    if (pasteTimer !== null) window.clearTimeout(pasteTimer);
    panVel = [0, 0];
    releaseAll();
  };
}
