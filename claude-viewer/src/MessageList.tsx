// Virtualized conversation with stick-to-bottom scrolling. Ported from the
// claude-web extension's MessageList.tsx.
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { ChatItem, ChatModel } from "./chatModel";
import { pendingItems, type PendingMessage } from "./pending";
import { ChatItemView } from "./ToolCall";

type Props = {
  model: ChatModel;
  /** What to draw: the main conversation's items, or a subagent card's children. */
  items: ChatItem[];
  /** Sent but not in the transcript yet - drawn after it (see pending.ts). */
  pending: PendingMessage[];
  /** Bumped whenever the (mutable) model changes, so we re-render and re-measure. */
  version: number;
  scrollRef: RefObject<HTMLDivElement>;
  stickToBottom: RefObject<boolean>;
  /** Rows were just put in front of the list (a page back to earlier
   *  messages): the row that was at the top of the view, to keep there. */
  prepended?: { seq: number; anchor: ScrollAnchor | null } | null;
};

/** A row and how far below the top of the scroll view it sat. */
export type ScrollAnchor = { key: string; offset: number };

/** The first row showing at the top of the scroll view. */
export function captureAnchor(scroller: HTMLElement | null): ScrollAnchor | null {
  if (!scroller) return null;
  const top = scroller.getBoundingClientRect().top;
  for (const row of scroller.querySelectorAll<HTMLElement>(".virtual-row[data-key]")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top + 1) return { key: row.dataset.key!, offset: rect.top - top };
  }
  return null;
}

// At most this many frames (about a second) spent keeping a place while the
// rows above it are measured.
const ANCHOR_FRAMES = 60;

/**
 * Virtualized transcript. Messages have unpredictable heights (markdown, tool
 * cards that expand), so rows are measured after render rather than assumed —
 * `measureElement` observes each mounted row and feeds real heights back.
 */
export function MessageList({ model, items: base, pending, version, scrollRef, stickToBottom, prepended }: Props) {
  // The given array while nothing is pending, so the common case allocates
  // nothing per render.
  const items = useMemo(
    () => (pending.length === 0 ? base : [...base, ...pendingItems(pending)]),
    [base, pending, version],
  );
  const count = items.length;
  const listRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    // Rough first guess; replaced by the real height once a row mounts.
    estimateSize: () => 90,
    overscan: 6,
    getItemKey: (index) => items[index]?.key ?? index,
  });

  const virtualRows = virtualizer.getVirtualItems();
  // Rows are measured only once mounted, so the total height keeps growing as
  // the list settles — re-pin on every size change, not just on new messages.
  const totalSize = virtualizer.getTotalSize();

  useLayoutEffect(() => {
    if (!stickToBottom.current || count === 0) return;
    virtualizer.scrollToIndex(count - 1, { align: "end" });
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, version, totalSize, virtualizer, scrollRef, stickToBottom]);

  // Rows put in front push everything down. Keep the row that was at the top
  // of the view where it was. Until it is mounted, place it from the
  // virtualizer's measurements, which improve each frame as the rows around
  // the view are measured; once mounted, from where it really is. Done when
  // it holds still, or the reader scrolls.
  const prependSeq = prepended?.seq ?? 0;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = prepended?.anchor;
    const list = listRef.current;
    if (!el || !list || !anchor || stickToBottom.current) return;
    const index = items.findIndex((item) => item.key === anchor.key);
    if (index < 0) return;
    let frames = 0;
    let still = 0;
    let raf = 0;
    const place = () => {
      const view = el.getBoundingClientRect().top;
      const row = el.querySelector<HTMLElement>(`.virtual-row[data-key="${CSS.escape(anchor.key)}"]`);
      if (row) {
        const drift = row.getBoundingClientRect().top - view - anchor.offset;
        if (Math.abs(drift) < 1) return true;
        el.scrollTop += drift;
        return false;
      }
      const measured = virtualizer.measurementsCache[index];
      if (measured) el.scrollTop = list.getBoundingClientRect().top - view + el.scrollTop + measured.start - anchor.offset;
      return false;
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      frames = ANCHOR_FRAMES;
    };
    // A scroll of the reader's own ends it: the place is theirs again.
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchmove", stop, { passive: true });
    const settle = () => {
      still = place() ? still + 1 : 0;
      if (++frames < ANCHOR_FRAMES && still < 2 && !stickToBottom.current) raf = requestAnimationFrame(settle);
    };
    place();
    raf = requestAnimationFrame(settle);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchmove", stop);
    };
  }, [prependSeq]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    if (listRef.current) observer.observe(listRef.current);
    return () => observer.disconnect();
  }, [scrollRef, stickToBottom]);

  return (
    <div className="chat-messages">
      <div
        ref={listRef}
        className="virtual-list"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualRows.map((row) => {
          const item = items[row.index];
          if (!item) return null;
          return (
            <div
              key={row.key}
              data-index={row.index}
              data-key={String(row.key)}
              ref={virtualizer.measureElement}
              className="virtual-row"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <ChatItemView item={item} model={model} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
