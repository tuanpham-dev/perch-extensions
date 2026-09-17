// Full-screen image viewer for every image in the conversation: arrows, keys
// and swipes step through them; the wheel, pinch, double-click and double-tap
// on the image zoom; dragging pans a zoomed image. It closes only from a tap
// or click on the dark overlay around the image, the × button, or Esc.
// Portalled to <body> so it escapes the virtualized list's transformed rows.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type LightboxApi = { open(src: string): void };
export const LightboxContext = createContext<LightboxApi>({ open: () => {} });
export const useLightbox = () => useContext(LightboxContext);

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const DOUBLE_TAP_MS = 300;
const SWIPE_PX = 60;

type Point = { x: number; y: number };

export function Lightbox({ images, index, onIndex, onClose }: { images: string[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ startScale: number; startOffset: Point; startDist: number; startMid: Point; startPoint: Point; moved: boolean } | null>(null);
  const lastTap = useRef(0);
  // Set once two fingers are down, cleared when the last one lifts: lifting
  // after a pinch must not read as a tap or a swipe.
  const multiTouch = useRef(false);
  // Where the press began. Pointer capture retargets the release to the
  // stage, so the release event can't tell an image tap from an overlay tap.
  const downOnImage = useRef(false);
  const view = useRef({ scale, offset });
  view.current = { scale, offset };

  const count = images.length;
  const go = useCallback((delta: number) => {
    if (count < 2) return;
    onIndex((index + delta + count) % count);
  }, [count, index, onIndex]);

  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [index]);

  // Zoom keeping the point under (px, py), stage coordinates from its center.
  const zoomAt = useCallback((px: number, py: number, next: number) => {
    const { scale: s, offset: o } = view.current;
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (clamped === 1) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
      return;
    }
    const k = clamped / s;
    setScale(clamped);
    setOffset({ x: px - (px - o.x) * k, y: py - (py - o.y) * k });
  }, []);

  const toStage = (clientX: number, clientY: number): Point => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "+" || e.key === "=") zoomAt(0, 0, view.current.scale * 1.5);
      else if (e.key === "-") zoomAt(0, 0, view.current.scale / 1.5);
      else if (e.key === "0") zoomAt(0, 0, 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose, zoomAt]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toStage(e.clientX, e.clientY);
      zoomAt(p.x, p.y, view.current.scale * Math.exp(-e.deltaY * 0.0025));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const beginGesture = () => {
    const pts = [...pointers.current.values()];
    const [a, b] = pts;
    gesture.current = {
      startScale: view.current.scale,
      startOffset: view.current.offset,
      startDist: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
      startMid: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a,
      startPoint: a,
      moved: false,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (pointers.current.size === 0) downOnImage.current = (e.target as HTMLElement).tagName === "IMG";
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // A pointer the browser no longer tracks; the gesture still works.
    }
    pointers.current.set(e.pointerId, toStage(e.clientX, e.clientY));
    if (pointers.current.size >= 2) multiTouch.current = true;
    beginGesture();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, toStage(e.clientX, e.clientY));
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, g.startScale * (dist / (g.startDist || dist))));
      const k = next / g.startScale;
      setScale(next);
      setOffset({
        x: mid.x - (g.startMid.x - g.startOffset.x) * k,
        y: mid.y - (g.startMid.y - g.startOffset.y) * k,
      });
      g.moved = true;
      return;
    }
    const p = pts[0];
    const dx = p.x - g.startPoint.x;
    const dy = p.y - g.startPoint.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
    if (view.current.scale > 1) setOffset({ x: g.startOffset.x + dx, y: g.startOffset.y + dy });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    const start = g?.startPoint;
    const end = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) {
      beginGesture();
      return;
    }
    gesture.current = null;
    const wasPinch = multiTouch.current;
    multiTouch.current = false;
    if (!g || wasPinch || !start || !end) return;
    const dx = end.x - start.x;
    if (view.current.scale === 1 && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(end.y - start.y)) {
      go(dx < 0 ? 1 : -1);
      return;
    }
    if (g.moved) return;
    if (!downOnImage.current) {
      onClose();
      return;
    }
    // Double-tap or double-click on the image toggles zoom.
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      zoomAt(end.x, end.y, view.current.scale > 1 ? 1 : 2.5);
      return;
    }
    lastTap.current = now;
  };

  const src = images[index];
  return createPortal(
    <div className="claude-viewer-lightbox" data-no-sidebar-swipe role="dialog" aria-label="Image viewer">
      <div
        ref={stageRef}
        className="claude-viewer-lightbox-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          className="claude-viewer-lightbox-image"
          src={src}
          alt={`Image ${index + 1} of ${count}`}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
      </div>
      <div className="claude-viewer-lightbox-bar">
        <span className="claude-viewer-lightbox-count">
          {index + 1} / {count}
        </span>
        <button onClick={() => zoomAt(0, 0, scale / 1.5)} disabled={scale <= MIN_SCALE} aria-label="Zoom out">
          −
        </button>
        <button onClick={() => zoomAt(0, 0, 1)} disabled={scale === 1} aria-label="Reset zoom">
          {Math.round(scale * 100)}%
        </button>
        <button onClick={() => zoomAt(0, 0, scale * 1.5)} disabled={scale >= MAX_SCALE} aria-label="Zoom in">
          +
        </button>
        <button onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {count > 1 && (
        <>
          <button className="claude-viewer-lightbox-nav claude-viewer-lightbox-prev" onClick={() => go(-1)} aria-label="Previous image">
            ‹
          </button>
          <button className="claude-viewer-lightbox-nav claude-viewer-lightbox-next" onClick={() => go(1)} aria-label="Next image">
            ›
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
