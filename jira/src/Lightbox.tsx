// A screenshot, full size, inside the editor region.
//
// It fills the Jira tab and stops there: the tab bar, the sidebar and the
// status bar stay visible and usable, so this reads as a viewer rather than a
// modal that has taken the app over. Everything it does with a pointer or a
// key matches `qa-report`'s own lightbox, because the same screenshots are
// read in both places and nobody should have to learn two sets of behaviour.
//
// Two mechanics are load-bearing and easy to get wrong:
//
//   * `wheel`, `touchstart` and `touchmove` are attached through a ref with
//     { passive: false }. React attaches its JSX handlers as passive, and a
//     preventDefault() inside one silently does nothing - the page would
//     scroll under the image while you tried to zoom it.
//   * the fit is recomputed from a ResizeObserver, not a window resize
//     listener. Dragging or collapsing the sidebar changes this region's
//     width without the window changing size at all.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { actualSize, fitted, isZoomed, panBy, step, toggleZoom, zoomAt, type ViewState } from "./lightboxModel";

export interface Shot {
  // Where the bytes come from - this extension's own route.
  src: string;
  // "CAP-110" and "before", so the caption always says which one this is.
  key: string;
  label: string;
}

export interface LightboxProps {
  shots: Shot[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}

const ZOOM_STEP = 1.4;

export default function Lightbox({ shots, index, onIndex, onClose }: LightboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<ViewState>({ scale: 1, x: 0, y: 0, fit: 1 });
  const shot = shots[index];

  // The viewport this image is fitted to, and the image's own size. Both are
  // read from the DOM, so refitting is one function both the load and the
  // resize path call.
  const refit = useCallback(() => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!stage || !img || !img.naturalWidth) return;
    setView(
      fitted(
        { width: img.naturalWidth, height: img.naturalHeight },
        { width: stage.clientWidth, height: stage.clientHeight },
      ),
    );
  }, []);

  // A new shot starts fitted, never carrying the previous one's zoom: two
  // images at different scales are not a comparison.
  useLayoutEffect(() => {
    refit();
  }, [shot?.src, refit]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => refit());
    observer.observe(stage);
    return () => observer.disconnect();
  }, [refit]);

  // Focus comes here on open so the keys below work, and goes back to
  // whatever opened it on close - handled by the caller, which knows what
  // that was.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const toCentre = (clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };

  // ---- wheel and touch, non-passive ----
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setView((current) => zoomAt(current, factor, toCentre(event.clientX, event.clientY)));
    };

    // One finger pans, two pinch. Tracked here rather than with JSX handlers
    // for the same passive-listener reason as the wheel.
    let touches: { id: number; x: number; y: number }[] = [];
    let pinchFrom = 0;

    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

    const onTouchStart = (event: TouchEvent) => {
      event.preventDefault();
      touches = [...event.touches].map((touch) => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY }));
      pinchFrom = touches.length >= 2 ? distance(touches[0], touches[1]) : 0;
    };

    const onTouchMove = (event: TouchEvent) => {
      event.preventDefault();
      const now = [...event.touches].map((touch) => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY }));
      if (now.length >= 2 && touches.length >= 2 && pinchFrom > 0) {
        const spread = distance(now[0], now[1]);
        const centre = toCentre((now[0].x + now[1].x) / 2, (now[0].y + now[1].y) / 2);
        setView((current) => zoomAt(current, spread / pinchFrom, centre));
        pinchFrom = spread;
      } else if (now.length === 1 && touches.length >= 1) {
        const previous = touches.find((entry) => entry.id === now[0].id) ?? touches[0];
        setView((current) => panBy(current, { x: now[0].x - previous.x, y: now[0].y - previous.y }));
      }
      touches = now;
    };

    const onTouchEnd = (event: TouchEvent) => {
      touches = [...event.touches].map((touch) => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY }));
      pinchFrom = touches.length >= 2 ? distance(touches[0], touches[1]) : 0;
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("touchstart", onTouchStart, { passive: false });
    stage.addEventListener("touchmove", onTouchMove, { passive: false });
    stage.addEventListener("touchend", onTouchEnd);
    return () => {
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("touchstart", onTouchStart);
      stage.removeEventListener("touchmove", onTouchMove);
      stage.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  // ---- mouse drag to pan ----
  const dragging = useRef<{ x: number; y: number; moved: boolean; onImage: boolean } | null>(null);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    // Whether the press landed on the image has to be decided HERE. The next
    // line captures the pointer to the stage, and from then on the browser
    // retargets every pointer event to the capture element - so by pointerup
    // `event.target` is the stage whatever was actually under the cursor, and
    // a click on the image would read as a click on the backdrop.
    dragging.current = {
      x: event.clientX,
      y: event.clientY,
      moved: false,
      onImage: event.target === imgRef.current,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragging.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    drag.x = event.clientX;
    drag.y = event.clientY;
    setView((current) => panBy(current, { x: dx, y: dy }));
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const drag = dragging.current;
    dragging.current = null;
    if (!drag || drag.moved) return;
    // A click that did not pan. On the image it toggles; anywhere else it is
    // the backdrop, which closes.
    if (drag.onImage) {
      setView((current) => toggleZoom(current, toCentre(event.clientX, event.clientY)));
    } else {
      onClose();
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Handled here and stopped here: while this is open, Z zooms rather than
    // reaching a terminal underneath.
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    // Tab must not walk out into the board and the detail pane: they are
    // still in the document, entirely covered by this, and focus landing
    // there simply disappears.
    if (event.key === "Tab") {
      const stops = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"),
      );
      if (stops.length > 0) {
        const first = stops[0];
        const last = stops[stops.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === event.currentTarget)) {
          handled();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          handled();
          first.focus();
        }
      }
      return;
    }
    switch (event.key) {
      case "Escape":
        handled();
        onClose();
        break;
      case "ArrowRight":
        handled();
        onIndex(step(index, 1, shots.length));
        break;
      case "ArrowLeft":
        handled();
        onIndex(step(index, -1, shots.length));
        break;
      case "z":
      case "Z":
        handled();
        setView((current) => (isZoomed(current) ? { ...current, scale: current.fit, x: 0, y: 0 } : actualSize(current)));
        break;
      case "+":
      case "=":
        handled();
        setView((current) => zoomAt(current, ZOOM_STEP, { x: 0, y: 0 }));
        break;
      case "-":
        handled();
        setView((current) => zoomAt(current, 1 / ZOOM_STEP, { x: 0, y: 0 }));
        break;
      case "0":
        handled();
        refit();
        break;
      default:
        break;
    }
  };

  if (!shot) return null;

  return (
    <div
      ref={rootRef}
      className="jira-lightbox"
      role="dialog"
      aria-modal="false"
      aria-label={`${shot.key} ${shot.label}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="jira-lb-bar">
        <span className="jira-lb-caption">
          <span className="jira-key">{shot.key}</span> {shot.label}
          {shots.length > 1 && (
            <span className="jira-lb-count">
              {index + 1} of {shots.length}
            </span>
          )}
        </span>
        <button className="icon-button" title="Fit to the pane (0)" onClick={refit}>
          <Icon name="screen-normal" />
        </button>
        <button
          className="icon-button"
          title="Actual pixels (Z)"
          onClick={() => setView((current) => (isZoomed(current) ? { ...current, scale: current.fit, x: 0, y: 0 } : actualSize(current)))}
        >
          <Icon name="zoom-in" />
        </button>
        <button className="icon-button" title="Close (Esc)" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div
        ref={stageRef}
        className={`jira-lb-stage${isZoomed(view) ? " zoomed" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <img
          ref={imgRef}
          src={shot.src}
          alt={`${shot.key} ${shot.label}`}
          draggable={false}
          onLoad={refit}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      </div>
      {/* Beside the picture rather than in the toolbar, where the cursor
          already is when you are comparing two shots - and where the eye
          looks for "the next one". Left out entirely for a single shot: two
          permanently dead arrows read as a viewer that is broken. */}
      {shots.length > 1 && (
        <>
          <button
            className="jira-lb-nav prev"
            title="Previous (left arrow)"
            aria-label="Previous screenshot"
            disabled={index === 0}
            onClick={() => onIndex(step(index, -1, shots.length))}
          >
            <Icon name="chevron-left" />
          </button>
          <button
            className="jira-lb-nav next"
            title="Next (right arrow)"
            aria-label="Next screenshot"
            disabled={index >= shots.length - 1}
            onClick={() => onIndex(step(index, 1, shots.length))}
          >
            <Icon name="chevron-right" />
          </button>
        </>
      )}
    </div>
  );
}
