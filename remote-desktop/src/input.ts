// Keyboard, pointer, wheel and paste capture on the viewer canvas, turned
// into wire messages. Keys travel by physical position (keymap.ts); a paste
// shortcut waits for the paste event so the clipboard text reaches the
// server before the keystroke does.
import { evdevForCode } from "./keymap";
import { clipClipboardText, type ClientMsg } from "./wire";

export interface InputTarget {
  send(msg: ClientMsg): void;
  /** Canvas client coordinates to remote pixels; null when unknown. */
  toRemote(clientX: number, clientY: number): { x: number; y: number } | null;
  onClipboardTruncated(): void;
}

// Wheel notches: pixels per remote scroll step, with line and page deltas
// normalised to pixels first.
const WHEEL_STEP_PX = 40;
const WHEEL_LINE_PX = 20;
const WHEEL_PAGE_PX = 400;
const MAX_WHEEL_STEPS = 12;
// How long a Ctrl+V keydown waits for its paste event before it is sent
// anyway (an empty clipboard fires no paste event).
const PASTE_WAIT_MS = 150;

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

export function attachInput(canvas: HTMLCanvasElement, target: InputTarget): () => void {
  const held = new Set<number>();
  const pressedButtons = new Set<number>();
  // Modifiers the remote holds on our behalf because an event carried the
  // flag without the key ever going down here (Shift pressed before the
  // canvas had focus, synthetic input): released when the flag clears.
  const implied = new Set<number>();
  let pendingMove: { x: number; y: number } | null = null;
  let moveFrame: number | null = null;
  let wheelAccX = 0;
  let wheelAccY = 0;
  let pasteTimer: number | null = null;
  let pasteKey: number | null = null;

  const sendKey = (code: number, down: boolean) => {
    if (down) held.add(code);
    else held.delete(code);
    target.send({ t: "key", code, down });
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
    implied.clear();
    for (const code of held) target.send({ t: "key", code, down: false });
    held.clear();
    for (const button of pressedButtons) target.send({ t: "button", button, down: false });
    pressedButtons.clear();
    target.send({ t: "releaseKeys" });
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
      // Let the browser fire `paste` so the text goes first; the keydown
      // follows from the paste handler or the timeout.
      if (pasteKey === null) {
        pasteKey = code;
        pasteTimer = window.setTimeout(flushPendingPasteKey, PASTE_WAIT_MS);
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && held.has(code)) return; // the remote X server autorepeats
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
    const text = e.clipboardData?.getData("text/plain") ?? "";
    e.preventDefault();
    if (text) {
      const clipped = clipClipboardText(text);
      target.send({ t: "clipboard", text: clipped.text });
      if (clipped.truncated) target.onClipboardTruncated();
    }
    flushPendingPasteKey();
  };

  const flushMove = () => {
    moveFrame = null;
    if (!pendingMove) return;
    target.send({ t: "move", x: pendingMove.x, y: pendingMove.y });
    pendingMove = null;
  };

  const queueMove = (e: PointerEvent) => {
    const pos = target.toRemote(e.clientX, e.clientY);
    if (!pos) return;
    pendingMove = pos;
    if (moveFrame === null) moveFrame = requestAnimationFrame(flushMove);
  };

  const xButton = (button: number): number | null => {
    switch (button) {
      case 0:
        return 1;
      case 1:
        return 2;
      case 2:
        return 3;
      case 3:
        return 8;
      case 4:
        return 9;
      default:
        return null;
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    canvas.focus({ preventScroll: true });
    const button = xButton(e.button);
    if (button === null) return;
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the browser does not track (synthetic events): no capture.
    }
    queueMove(e);
    flushMove();
    pressedButtons.add(button);
    target.send({ t: "button", button, down: true });
  };

  const onPointerUp = (e: PointerEvent) => {
    const button = xButton(e.button);
    if (button === null) return;
    e.preventDefault();
    queueMove(e);
    flushMove();
    pressedButtons.delete(button);
    target.send({ t: "button", button, down: false });
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
    wheelAccX += e.deltaX * scale;
    wheelAccY += e.deltaY * scale;
    const stepsX = Math.trunc(wheelAccX / WHEEL_STEP_PX);
    const stepsY = Math.trunc(wheelAccY / WHEEL_STEP_PX);
    if (stepsX === 0 && stepsY === 0) return;
    wheelAccX -= stepsX * WHEEL_STEP_PX;
    wheelAccY -= stepsY * WHEEL_STEP_PX;
    const clamp = (v: number) => Math.max(-MAX_WHEEL_STEPS, Math.min(MAX_WHEEL_STEPS, v));
    // Wire: dy > 0 scrolls up (X button 4); the browser's deltaY > 0 scrolls down.
    target.send({ t: "wheel", dx: clamp(stepsX), dy: clamp(-stepsY) });
  };

  const onContextMenu = (e: Event) => e.preventDefault();
  const onBlur = () => releaseAll();
  const onVisibility = () => {
    if (document.hidden) releaseAll();
  };

  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("paste", onPaste);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", queueMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    canvas.removeEventListener("keydown", onKeyDown);
    canvas.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("paste", onPaste);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", queueMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContextMenu);
    canvas.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    if (moveFrame !== null) cancelAnimationFrame(moveFrame);
    if (pasteTimer !== null) window.clearTimeout(pasteTimer);
    releaseAll();
  };
}
