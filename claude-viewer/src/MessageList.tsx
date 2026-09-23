// Virtualized conversation with stick-to-bottom scrolling. Ported from the
// claude-web extension's MessageList.tsx.
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { ChatModel } from "./chatModel";
import { pendingItems, type PendingMessage } from "./pending";
import { ChatItemView } from "./ToolCall";

type Props = {
  model: ChatModel;
  /** Sent but not in the transcript yet - drawn after it (see pending.ts). */
  pending: PendingMessage[];
  /** Bumped whenever the (mutable) model changes, so we re-render and re-measure. */
  version: number;
  scrollRef: RefObject<HTMLDivElement>;
  stickToBottom: RefObject<boolean>;
};

/**
 * Virtualized transcript. Messages have unpredictable heights (markdown, tool
 * cards that expand), so rows are measured after render rather than assumed —
 * `measureElement` observes each mounted row and feeds real heights back.
 */
export function MessageList({ model, pending, version, scrollRef, stickToBottom }: Props) {
  // The model's own array while nothing is pending, so the common case
  // allocates nothing per render.
  const items = useMemo(
    () => (pending.length === 0 ? model.items : [...model.items, ...pendingItems(pending)]),
    [model.items, pending, version],
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
