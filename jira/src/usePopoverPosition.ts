// Where a popover card lands. Extracted from the details popover so the
// filter funnel, the start-work form and the project picker all place
// themselves the same way.
//
// Placement is MEASURED rather than estimated, and that matters more now than
// it did with one small card: these range from a four-row filter list to a
// full comment thread, so whether a card opens downwards or upwards has to be
// decided from the height it is actually about to have. The card stays hidden
// until it has been measured, so it never paints at the wrong spot first.
import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

export interface PopoverAnchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// Read at click time, before any await: the event's target must not be
// touched afterwards, and a live element would move under a scroll.
export function anchorOf(el: HTMLElement): PopoverAnchor {
  const rect = el.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}

const MARGIN = 8;
const GAP = 4;

// `deps` are the values whose change can resize the card - its loaded
// contents, typically. Pass a constant-length array: the effect compares its
// entries, not the array itself.
export function usePopoverPosition<T extends HTMLElement>(
  anchor: PopoverAnchor,
  deps: readonly unknown[] = [],
): { ref: React.MutableRefObject<T | null>; style: CSSProperties } {
  const ref = useRef<T | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const card = el.getBoundingClientRect();
    // Clamped from the right first, so a card wider than the viewport pins to
    // the left gutter instead of being pushed off the left edge entirely.
    const rightmost = Math.max(MARGIN, window.innerWidth - card.width - MARGIN);
    const left = Math.min(Math.max(MARGIN, anchor.left), rightmost);
    const below = anchor.bottom + GAP;
    const top =
      below + card.height + MARGIN > window.innerHeight
        ? Math.max(MARGIN, anchor.top - card.height - GAP)
        : below;
    setPos({ top, left });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, ...deps]);

  return {
    ref,
    style: pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" },
  };
}
