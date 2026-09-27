// A floating panel anchored to a toolbar button, matching the host's own
// popovers (StatusBarPopover in Perch): the host's `.status-bar-popover`
// surface, 4px from the trigger and the viewport edges, right-aligned to
// the trigger, dismissed by a press outside, Escape or window blur, and a
// trigger marked `data-menu-trigger` toggles it instead of reopening it.
// The toolbar sits at the top of the tab, so this drops DOWN where the
// status bar's popovers open up.
//
// The press that dismisses belongs to the popover, not to what it lands
// on: over the remote desktop it would otherwise also click a window there.
// The whole press is swallowed (pointer, touch, mouse and click events),
// including the part that arrives after the popover has already unmounted.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const GAP = 4;
const EDGE = 4;
// Longest a press may take to finish before its leftovers stop being eaten.
const SWALLOW_MS = 700;

interface Props {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  className?: string;
  children: ReactNode;
}

function swallowRestOfPress(): void {
  const types = ["touchstart", "mousedown", "pointerup", "touchend", "mouseup", "click"] as const;
  const eat = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "click") window.setTimeout(done, 0);
  };
  const opts = { capture: true, passive: false } as const;
  const done = () => types.forEach((t) => window.removeEventListener(t, eat, opts));
  types.forEach((t) => window.addEventListener(t, eat, opts));
  window.setTimeout(done, SWALLOW_MS);
}

export function AnchoredPopover({ anchorRef, onClose, label, className, children }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Off-screen for the first paint: the panel's own width decides its left
  // edge, so it is measured before it is shown.
  const [pos, setPos] = useState({ left: -9999, top: 0, maxHeight: 0 });

  const place = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const el = ref.current;
    if (!anchor || !el) return;
    const width = el.getBoundingClientRect().width;
    const top = anchor.bottom + GAP;
    setPos({
      left: Math.max(EDGE, Math.min(anchor.right - width, window.innerWidth - EDGE - width)),
      top,
      maxHeight: Math.max(0, window.innerHeight - top - EDGE),
    });
  }, [anchorRef]);

  useLayoutEffect(() => {
    place();
  }, [place, children]);

  useEffect(() => {
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place]);

  useEffect(() => {
    const onPress = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-menu-trigger]")) return;
      e.preventDefault();
      e.stopPropagation();
      swallowRestOfPress();
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const opts = { capture: true, passive: false } as const;
    window.addEventListener("pointerdown", onPress, opts);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPress, opts);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`status-bar-popover${className ? ` ${className}` : ""}`}
      style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight }}
    >
      {children}
    </div>,
    document.body,
  );
}
