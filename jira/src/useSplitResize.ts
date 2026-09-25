// A draggable divider between the editor tab's ticket list and its detail
// pane. The size is the DETAIL pane's: the list is what should grow with the
// tab, so a wider window gives the extra room to the table.
//
// Direction follows the layout, not a breakpoint copied from the stylesheet:
// the split runs side by side or top-to-bottom as the user chose (see
// useLayoutChoice), or by the container width style.css decides when they
// haven't, and this reads the computed flex-direction to learn which way it
// currently runs. One source of truth, so the two can't drift apart.
//
// The split is found through a CALLBACK ref, not a ref object read in a mount
// effect. The tab shows its loading and not-configured states first and only
// renders the split later, so a mount-time effect saw no element, never ran
// again, and left the measured size at zero - which clamped every drag to the
// minimum and made the divider look dead.
//
// Remembered per direction in localStorage - a width that suits a desktop
// tab is meaningless as a height on a phone, and a pane size is a per-screen
// convenience, not something to sync across devices through settings.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

const MIN_DETAIL = 220;
const MIN_LIST = 240;
const KEY_STEP = 24;
const STORAGE_KEY = "perch.jira.detailSize";
const LAYOUT_KEY = "perch.jira.layout";

export type Direction = "row" | "column";

// The user's layout choice: side by side ("row"), top and bottom
// ("column"), or null for automatic - side by side unless the tab is too
// narrow for it. Remembered per browser like the size, for the same reason.
//
// One value for the whole extension, not one per component: the toggle sits
// in the tab's header while the split it governs may be the Batches area's,
// a different component with its own call to this hook. Each holding its own
// copy of the choice meant the Batches split only learnt of a change when it
// was remounted - by leaving for the table and coming back.
function readLayout(): Direction | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw === "row" || raw === "column" ? raw : null;
  } catch {
    return null;
  }
}

let layoutChoice: Direction | null | undefined;
const layoutListeners = new Set<() => void>();

function currentLayout(): Direction | null {
  if (layoutChoice === undefined) layoutChoice = readLayout();
  return layoutChoice;
}

function subscribeLayout(cb: () => void): () => void {
  layoutListeners.add(cb);
  return () => {
    layoutListeners.delete(cb);
  };
}

function chooseLayout(next: Direction): void {
  if (next === layoutChoice) return;
  layoutChoice = next;
  try {
    localStorage.setItem(LAYOUT_KEY, next);
  } catch {
    // Blocked storage: the choice still holds for this session.
  }
  for (const cb of layoutListeners) cb();
}

export function useLayoutChoice(): [Direction | null, (next: Direction) => void] {
  const layout = useSyncExternalStore(subscribeLayout, currentLayout, currentLayout);
  return [layout, chooseLayout];
}

function readSize(direction: Direction): number | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}.${direction}`);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    // Blocked storage (a private window, a sandboxed frame) just means the
    // default size - never a broken pane.
    return null;
  }
}

function writeSize(direction: Direction, size: number | null): void {
  try {
    const key = `${STORAGE_KEY}.${direction}`;
    if (size === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(size)));
  } catch {
    // See readSize.
  }
}

export interface SplitResize {
  // Attach to the element whose flex-direction decides the split.
  splitRef: (el: HTMLElement | null) => void;
  direction: Direction;
  // The detail pane's flex-basis, or undefined for the stylesheet's default.
  detailStyle: { flex: string } | undefined;
  handleProps: {
    role: "separator";
    tabIndex: number;
    "aria-orientation": "vertical" | "horizontal";
    "aria-label": string;
    "aria-valuenow"?: number;
    title: string;
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
    onDoubleClick: () => void;
  };
  dragging: boolean;
}

// `layout` is only a dependency here: the stylesheet applies it (a class on
// the split), and a class change resizes nothing, so no ResizeObserver would
// fire - the split has to be re-read when it changes.
export function useSplitResize(layout: Direction | null): SplitResize {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [direction, setDirection] = useState<Direction>("row");
  const [total, setTotal] = useState(0);
  const [size, setSize] = useState<number | null>(() => readSize("row"));
  const [dragging, setDragging] = useState(false);
  const directionRef = useRef<Direction>("row");

  // Track the split's box and which way it runs. A direction change swaps in
  // that direction's own remembered size rather than reusing the other one.
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const next: Direction = getComputedStyle(el).flexDirection === "column" ? "column" : "row";
      const rect = el.getBoundingClientRect();
      setTotal(next === "row" ? rect.width : rect.height);
      if (next !== directionRef.current) {
        directionRef.current = next;
        setDirection(next);
        setSize(readSize(next));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, layout]);

  // Clamped at render as well as while dragging, so a size remembered from a
  // wider window can never squeeze the list below its minimum.
  const clamp = useCallback(
    (value: number) => {
      const max = Math.max(MIN_DETAIL, total - MIN_LIST);
      return Math.min(max, Math.max(MIN_DETAIL, value));
    },
    [total],
  );

  const commit = useCallback((value: number | null) => {
    setSize(value);
    writeSize(directionRef.current, value);
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!el || e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      setDragging(true);
      let latest: number | null = null;

      // The detail pane sits on the right (or below), so its size is the
      // distance from the pointer to the split's far edge.
      const onMove = (ev: PointerEvent) => {
        const rect = el.getBoundingClientRect();
        const raw = directionRef.current === "row" ? rect.right - ev.clientX : rect.bottom - ev.clientY;
        const max = Math.max(MIN_DETAIL, (directionRef.current === "row" ? rect.width : rect.height) - MIN_LIST);
        latest = Math.min(max, Math.max(MIN_DETAIL, raw));
        setSize(latest);
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        setDragging(false);
        // Written once at the end rather than on every frame of the drag.
        if (latest !== null) writeSize(directionRef.current, latest);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [el],
  );

  const current = size === null ? null : clamp(size);

  // Arrow keys move the divider for keyboard users; the pane grows toward the
  // list, which is left of it (or above it).
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      const grow = directionRef.current === "row" ? "ArrowLeft" : "ArrowUp";
      const shrink = directionRef.current === "row" ? "ArrowRight" : "ArrowDown";
      if (e.key !== grow && e.key !== shrink) return;
      e.preventDefault();
      const start =
        current ??
        (el?.querySelector<HTMLElement>(".jira-split-detail")?.getBoundingClientRect()[
          directionRef.current === "row" ? "width" : "height"
        ] ??
          MIN_DETAIL);
      commit(clamp(start + (e.key === grow ? KEY_STEP : -KEY_STEP)));
    },
    [clamp, commit, current, el],
  );

  return {
    splitRef: setEl,
    direction,
    dragging,
    detailStyle: current === null ? undefined : { flex: `0 0 ${current}px` },
    handleProps: {
      role: "separator",
      tabIndex: 0,
      // A separator's orientation is the line's, which is across the split.
      "aria-orientation": direction === "row" ? "vertical" : "horizontal",
      "aria-label": "Resize ticket details",
      "aria-valuenow": current === null ? undefined : Math.round(current),
      title: "Drag to resize. Double-click to reset.",
      onPointerDown,
      onKeyDown,
      onDoubleClick: () => commit(null),
    },
  };
}
