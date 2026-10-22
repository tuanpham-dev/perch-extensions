import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { host } from "./host";

const isWebUrl = (href: string | null | undefined): href is string => !!href && /^https?:\/\//i.test(href);

// Opens a web address in Perch's web preview (the built-in browser, Perch
// 0.9.4+), or in a new browser tab when nothing in the app can show it.
export function openInWebPreview(url: string): void {
  if (host.app?.openUrlInApp?.(url)) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

// A link in a rendered note. Click opens it in a new browser tab; Shift+click
// (Perch's secondary click) opens a web address in the web preview instead.
// Neither starts editing the note.
export function NoteLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={isWebUrl(href) ? `${href}\nShift+click to open in the web preview` : href}
      onClick={(e) => {
        e.stopPropagation();
        if (e.shiftKey && isWebUrl(href)) {
          e.preventDefault();
          openInWebPreview(href);
        }
      }}
    >
      {children}
    </a>
  );
}

export const MARKDOWN_COMPONENTS = { a: NoteLink };

export interface ContextItem {
  label: string;
  icon?: string;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
}

const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

// The right-click items for what's under the pointer in a rendered note: the
// link, if it's on one, and the selected text, if any is selected inside
// `body`. Select All always, so a note can be copied whole.
export function textItems(target: EventTarget | null, body: HTMLElement): ContextItem[] {
  const items: ContextItem[] = [];
  const link = target instanceof Element ? target.closest("a[href]") : null;
  const href = link && body.contains(link) ? link.getAttribute("href") : null;
  if (href) {
    items.push({ label: "Open Link", icon: "link-external", onClick: () => window.open(href, "_blank", "noopener,noreferrer") });
    if (isWebUrl(href)) items.push({ label: "Open Link in Web Preview", icon: "globe", onClick: () => openInWebPreview(href) });
    items.push({ label: "Copy Link Address", icon: "link", onClick: () => copy(href) });
  }
  const selection = window.getSelection();
  const selected =
    selection && !selection.isCollapsed && body.contains(selection.anchorNode) ? selection.toString() : "";
  if (selected) {
    if (items.length) items.push({ label: "", separator: true });
    items.push({ label: "Copy", icon: "copy", onClick: () => copy(selected) });
  }
  if (items.length) items.push({ label: "", separator: true });
  items.push({
    label: "Select All",
    icon: "list-selection",
    onClick: () => {
      const range = document.createRange();
      range.selectNodeContents(body);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    },
  });
  return items;
}

// A right-click menu drawn by the extension itself (a note card has no host
// menu): `open` it from a contextmenu event with its items, and render
// `element`. Shift+right-click is left to the browser's own menu.
export function useContextMenu(): {
  open: (e: React.MouseEvent, items: ContextItem[]) => void;
  element: React.ReactNode;
} {
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[] } | null>(null);
  const open = (e: React.MouseEvent, items: ContextItem[]) => {
    e.stopPropagation();
    if (e.shiftKey) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  return { open, element: menu && <ContextMenu {...menu} onClose={() => setMenu(null)} /> };
}

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Kept on screen: flipped left or up when it would run off an edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: x + r.width > window.innerWidth - 4 ? Math.max(4, x - r.width) : x,
      top: y + r.height > window.innerHeight - 4 ? Math.max(4, y - r.height) : y,
    });
  }, [x, y]);

  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="fn-popup fn-menu notes-context-menu" role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="notes-context-separator" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={item.danger ? "danger" : undefined}
            onClick={() => {
              onClose();
              item.onClick?.();
            }}
          >
            <span className={`codicon codicon-${item.icon ?? "blank"}`} aria-hidden="true" /> {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
