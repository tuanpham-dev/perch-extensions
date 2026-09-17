import { useEffect, useState, type RefObject } from "react";

// How tall an overlay band can be and still count as a bottom strip rather
// than a panel covering the tab.
const MAX_BAND_PX = 120;

// The height of any app overlay band (registerAppOverlay, e.g. one-hand's
// bottom gesture strip) that takes taps over the bottom edge of the tab, so
// the tab can leave that much room and keep the composer tappable. Measured from geometry instead of a class name so it follows
// whichever overlay extension draws the band.
export function useOverlayInset(rootRef: RefObject<HTMLElement | null>): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let raf = 0;
    let settleTimer = 0;
    const measure = () => {
      const rect = root.getBoundingClientRect();
      // A hidden tab has no box; keep the last value so it doesn't jump back.
      if (rect.width === 0 || rect.height === 0) return;
      let next = 0;
      if (observedLayer) {
        for (const el of observedLayer.querySelectorAll<HTMLElement>("*")) {
          const band = el.getBoundingClientRect();
          if (band.height === 0 || band.height > MAX_BAND_PX) continue;
          if (band.width < rect.width * 0.6) continue;
          if (band.right <= rect.left || band.left >= rect.right) continue;
          if (band.bottom < rect.bottom - 2 || band.top >= rect.bottom) continue;
          if (getComputedStyle(el).pointerEvents === "none") continue;
          next = Math.max(next, Math.ceil(rect.bottom - band.top));
        }
      }
      setInset((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
      // Trailing re-measure: a layout that settles by moving things (the
      // mobile sidebar sliding shut at load) fires none of the observers.
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(measure, 300);
    };

    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    // Overlays mount after the tab, move (a docked keyboard lifts one-hand's
    // strip) and toggle with their settings. The layer itself only exists
    // while some extension registers an overlay, so .main is watched for it.
    const main = root.closest(".main") ?? document.querySelector(".main") ?? document.body;
    let observedLayer: Element | null = null;
    const layerObserver = new MutationObserver(schedule);
    const watchLayer = () => {
      const layer = main.querySelector(":scope > .app-overlay-layer");
      if (layer === observedLayer) return;
      observedLayer = layer;
      layerObserver.disconnect();
      if (layer) layerObserver.observe(layer, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
    };
    const mainObserver = new MutationObserver(() => {
      watchLayer();
      schedule();
    });
    mainObserver.observe(main, { childList: true });
    watchLayer();
    window.addEventListener("resize", schedule);
    document.addEventListener("transitionend", schedule, true);
    schedule();

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
      resize.disconnect();
      layerObserver.disconnect();
      mainObserver.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("transitionend", schedule, true);
    };
  }, [rootRef]);
  return inset;
}
