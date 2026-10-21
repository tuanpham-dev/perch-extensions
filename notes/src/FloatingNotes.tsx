// Notes as sticky cards floating over what they belong to: a terminal's own
// notes and its project's over the terminal (a terminal accessory), a file's
// notes over its preview tabs (a viewer accessory). A chip in the corner
// counts them and adds, hides and shows them. Each card's colour, box (as
// shares of the area, so it holds across resizes and devices) and hidden
// flag live with the note on the server.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { BodySaver } from "./bodySaver";
import { call, host } from "./host";
import {
  clearPendingCardEdit,
  NOTE_COLORS,
  notesChanged,
  onNotesChanged,
  patchNote,
  peekPendingCardEdit,
  removeNote,
  saveBody,
  type Note,
  type NoteColor,
} from "./notesStore";
import { useShowChip } from "./settings";

export type Surface =
  | { kind: "window"; sessionName: string; windowIndex: number }
  | { kind: "file"; filePath: string };

interface FloatData {
  key: string | null;
  hiddenAll: boolean;
  notes: Note[];
}

const SAVE_DELAY_MS = 800;

// Links open in a new tab, and clicking one doesn't start editing the note.
const MARKDOWN_COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      {children}
    </a>
  ),
};
const MIN_W = 160;
const MIN_H = 100;
// Below this the area is a small grid cell: the chip alone, no cards.
const SMALL_W = 360;
const SMALL_H = 240;

const LABELS: Record<Note["scope"], string> = { window: "Note", project: "Project", file: "File" };

function query(surface: Surface): string {
  return surface.kind === "file"
    ? `/float?file=${encodeURIComponent(surface.filePath)}`
    : `/float?session=${encodeURIComponent(surface.sessionName)}&window=${surface.windowIndex}`;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A note's card box in pixels: its saved layout, or a cascade from the top
// right for one that has never been placed.
function boxFor(note: Note, index: number, size: { w: number; h: number }): Box {
  if (note.layout) {
    return { x: note.layout.x * size.w, y: note.layout.y * size.h, w: note.layout.w * size.w, h: note.layout.h * size.h };
  }
  const w = Math.max(MIN_W, Math.min(280, size.w * 0.42));
  const h = Math.max(MIN_H, Math.min(180, size.h * 0.45));
  const x = Math.max(0, size.w - w - 28 - index * 22);
  const y = Math.min(Math.max(0, size.h - h), 44 + index * 26);
  return { x, y, w, h };
}

function clampBox(b: Box, size: { w: number; h: number }): Box {
  const w = Math.min(size.w, Math.max(MIN_W, b.w));
  const h = Math.min(size.h, Math.max(MIN_H, b.h));
  return { x: Math.min(size.w - w, Math.max(0, b.x)), y: Math.min(size.h - h, Math.max(0, b.y)), w, h };
}

const toLayout = (b: Box, size: { w: number; h: number }) => ({ x: b.x / size.w, y: b.y / size.h, w: b.w / size.w, h: b.h / size.h });

function Icon({ name }: { name: string }) {
  return <span className={`codicon codicon-${name}`} aria-hidden="true" />;
}

// ---- One card ----

function Card({
  note,
  box,
  size,
  autoEdit,
  onBusy,
  ownFile,
}: {
  note: Note;
  box: Box;
  size: { w: number; h: number };
  autoEdit: boolean;
  onBusy: (id: string, busy: boolean) => void;
  // The file this card floats over (on that file's preview), if any: no
  // Open button there, it's already open.
  ownFile?: string;
}) {
  const [live, setLive] = useState<Box | null>(null);
  const [editing, setEditing] = useState(autoEdit);
  const [text, setText] = useState(note.body);
  const [menu, setMenu] = useState<"color" | "more" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const saver = useRef<BodySaver | null>(null);
  saver.current ??= new BodySaver((body) => saveBody(note.id, body), note.body);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const shown = live ?? box;
  const color: NoteColor = note.color ?? "yellow";

  // Another device's edit, unless this one is being edited or has typing
  // that isn't saved yet.
  useEffect(() => {
    if (!editing && saver.current?.external(note.body)) setText(note.body);
  }, [note.body, editing]);

  useEffect(() => {
    if (editing) {
      clearPendingCardEdit(note.id);
      onBusy(note.id, true);
      requestAnimationFrame(() => textRef.current?.focus());
      return () => onBusy(note.id, false);
    }
  }, [editing, note.id, onBusy]);

  // Saves whatever is typed now, after any save still in flight; typing that
  // lands meanwhile keeps the card dirty, so it gets saved too.
  const flush = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    saver.current?.flush().catch((err: Error) => setError(err.message));
  };

  const stopEditing = () => {
    flush();
    setEditing(false);
  };

  // Typing not yet saved when the card goes away is saved anyway.
  useEffect(
    () => () => {
      if (saver.current?.dirty) flush();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Drag (header) or resize (corner): pointer capture, then one save.
  const startGesture = (e: React.PointerEvent, kind: "move" | "resize") => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { px: e.clientX, py: e.clientY, box: shown };
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    onBusy(note.id, true);
    let last = shown;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      last = clampBox(
        kind === "move"
          ? { ...start.box, x: start.box.x + dx, y: start.box.y + dy }
          : { ...start.box, w: start.box.w + dx, h: start.box.h + dy },
        size,
      );
      setLive(last);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      onBusy(note.id, false);
      patchNote(note.id, { layout: toLayout(last, size) })
        .catch((err: Error) => setError(err.message))
        .finally(() => setLive(null));
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const remove = async () => {
    setMenu(null);
    if (note.body.trim() && !(await host.app?.confirmDialog?.("Delete this note?", "Delete"))) return;
    removeNote(note.id).catch((err: Error) => setError(err.message));
  };

  return (
    <div
      className={`fn-card fn-${color}`}
      style={{ left: shown.x, top: shown.y, width: shown.w, height: shown.h }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      data-keyboard-capture={editing ? "true" : undefined}
      data-no-sidebar-swipe="true"
    >
      <div className="fn-head" onPointerDown={(e) => startGesture(e, "move")}>
        {note.scope === "file" && note.filePath ? (
          <span className="fn-label fn-label-file" title={note.filePath}>
            <Icon name="file" />
            <span className="fn-path">{note.relPath ?? note.filePath.split(/[\\/]/).pop()}</span>
          </span>
        ) : (
          <span className="fn-label">{LABELS[note.scope]}</span>
        )}
        <span className="fn-spacer" />
        {note.scope === "file" && note.filePath && note.filePath !== ownFile && (
          <button
            className="fn-icon"
            title={`Open ${note.relPath ?? note.filePath}`}
            aria-label="Open file"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => host.app?.openPreview?.(note.filePath!)}
          >
            <Icon name="go-to-file" />
          </button>
        )}
        {!editing && (
          <button
            className="fn-icon"
            title="Edit"
            aria-label="Edit note"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setEditing(true)}
          >
            <Icon name="edit" />
          </button>
        )}
        <button
          className="fn-icon"
          title="Change colour"
          aria-label="Change colour"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setMenu((m) => (m === "color" ? null : "color"))}
        >
          <Icon name="symbol-color" />
        </button>
        <button
          className="fn-icon"
          title="More"
          aria-label="More actions"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setMenu((m) => (m === "more" ? null : "more"))}
        >
          <Icon name="ellipsis" />
        </button>
        <button
          className="fn-icon"
          title="Hide this note"
          aria-label="Hide this note"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => patchNote(note.id, { hidden: true }).catch((err: Error) => setError(err.message))}
        >
          <Icon name="eye-closed" />
        </button>
      </div>
      {menu === "color" && (
        <div className="fn-popup fn-swatches" role="menu" aria-label="Colour">
          {NOTE_COLORS.map((c) => (
            <button
              key={c}
              role="menuitemradio"
              aria-checked={c === color}
              title={c[0].toUpperCase() + c.slice(1)}
              className={`fn-swatch fn-${c}${c === color ? " current" : ""}`}
              onClick={() => {
                setMenu(null);
                patchNote(note.id, { color: c }).catch((err: Error) => setError(err.message));
              }}
            />
          ))}
        </div>
      )}
      {menu === "more" && (
        <div className="fn-popup fn-menu" role="menu">
          <button role="menuitem" onClick={() => (setMenu(null), setEditing(true))}>
            <Icon name="edit" /> Edit
          </button>
          <button role="menuitem" onClick={() => (setMenu(null), host.app?.revealSidebarPanel?.("notes"))}>
            <Icon name="list-flat" /> Show in NOTES
          </button>
          <button role="menuitem" className="danger" onClick={() => void remove()}>
            <Icon name="trash" /> Delete…
          </button>
        </div>
      )}
      <div className="fn-body">
        {editing ? (
          <textarea
            ref={textRef}
            className="fn-editor"
            value={text}
            placeholder="Write in Markdown…"
            onChange={(e) => {
              const value = e.target.value;
              setText(value);
              saver.current?.edit(value);
              if (timer.current !== null) window.clearTimeout(timer.current);
              timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
            }}
            onBlur={stopEditing}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                stopEditing();
              }
            }}
          />
        ) : (
          // A double-click edits; a single click is free for selecting text
          // and following links.
          <div className="fn-rendered" onDoubleClick={() => setEditing(true)} title="Double-click to edit">
            {text.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={MARKDOWN_COMPONENTS}>
                {text}
              </ReactMarkdown>
            ) : (
              <span className="fn-placeholder">Empty note. Double-click to write.</span>
            )}
          </div>
        )}
        {error && <div className="fn-error">{error}</div>}
      </div>
      <span className="fn-grip" onPointerDown={(e) => startGesture(e, "resize")} title="Resize" aria-hidden="true">
        {/* The usual corner grip: two diagonal strokes in the bottom-right
            corner, rising left to right. No codicon draws this. */}
        <svg viewBox="0 0 10 10" width="10" height="10">
          <path d="M9 3 L3 9 M9 6.5 L6.5 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
        </svg>
      </span>
    </div>
  );
}

// ---- The layer: chip + cards ----

export function NotesLayer({ surface, mobilePointer, corner }: { surface: Surface; mobilePointer: boolean; corner: "top" | "bottom" }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [data, setData] = useState<FloatData>({ key: null, hiddenAll: false, notes: [] });
  const [addMenu, setAddMenu] = useState(false);
  const [autoEditId, setAutoEditId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Notes being dragged or edited here keep their local state over updates.
  const busy = useRef(new Set<string>());
  const surfaceKey = surface.kind === "file" ? `file:${surface.filePath}` : `${surface.sessionName}\u0000${surface.windowIndex}`;

  // Set when a change arrived while this layer couldn't be seen, so it
  // fetches once it can.
  const stale = useRef(false);

  const load = useCallback(() => {
    // Hidden tabs (display: none) and hidden pages wait until they show.
    if (!layerRef.current?.offsetParent || document.hidden) {
      stale.current = true;
      return;
    }
    stale.current = false;
    call<FloatData>(query(surface))
      .then((next) =>
        setData((prev) => ({
          ...next,
          notes: next.notes.map((n) => (busy.current.has(n.id) ? (prev.notes.find((p) => p.id === n.id) ?? n) : n)),
        })),
      )
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceKey]);

  useEffect(() => {
    load();
    const off = onNotesChanged(load);
    // A tab that was display: none gets a size again when it's shown; a
    // page that was in the background becomes visible.
    const catchUp = () => stale.current && load();
    const ro = new ResizeObserver(catchUp);
    if (layerRef.current) ro.observe(layerRef.current);
    document.addEventListener("visibilitychange", catchUp);
    return () => {
      off();
      ro.disconnect();
      document.removeEventListener("visibilitychange", catchUp);
    };
  }, [load]);

  useLayoutEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
      if (r.width > 0) load();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [load]);

  const onBusy = useCallback((id: string, isBusy: boolean) => {
    if (isBusy) busy.current.add(id);
    else busy.current.delete(id);
  }, []);

  const notes = data.notes;
  const hiddenOne = notes.filter((n) => n.hidden);
  const small = size.w < SMALL_W || size.h < SMALL_H;
  const cardsAllowed = !mobilePointer && !small && !data.hiddenAll;
  const visibleNotes = cardsAllowed ? notes.filter((n) => !n.hidden) : [];

  const add = async (scope: "window" | "project" | "file") => {
    setAddMenu(false);
    setError(null);
    const index = visibleNotes.length;
    const initial = size.w > 0 ? toLayout(boxFor({ id: "", scope, projectPath: "", body: "", createdAt: 0, updatedAt: 0, detached: false }, index, size), size) : undefined;
    try {
      const active = host.app?.getActiveContext();
      const body =
        surface.kind === "file"
          ? { session: active?.sessionName ?? null, scope: "file", filePath: surface.filePath, body: "", layout: initial }
          : { session: surface.sessionName, window: surface.windowIndex, scope, body: "", layout: initial };
      const note = await call<Note>("/notes", { method: "POST", body: JSON.stringify(body) });
      if (data.hiddenAll && data.key) await call("/surface", { method: "PUT", body: JSON.stringify({ key: data.key, hidden: false }) });
      setAutoEditId(note.id);
      notesChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const setHiddenAll = async (hidden: boolean) => {
    if (!data.key) return;
    setData((d) => ({ ...d, hiddenAll: hidden }));
    try {
      await call("/surface", { method: "PUT", body: JSON.stringify({ key: data.key, hidden }) });
      notesChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const showAll = async () => {
    try {
      await call("/show-all", { method: "POST", body: JSON.stringify({ ids: hiddenOne.map((n) => n.id) }) });
      if (data.hiddenAll) await setHiddenAll(false);
      notesChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const countOnly = mobilePointer || small;
  // Settings → Notes → "Show the Notes chip": off leaves just the cards.
  const showChip = useShowChip();

  return (
    <div className="fn-layer" ref={layerRef}>
      {visibleNotes.map((n, i) => (
        <Card
          key={n.id}
          note={n}
          box={clampBox(boxFor(n, i, size), size)}
          size={size}
          autoEdit={n.id === autoEditId || n.id === peekPendingCardEdit()}
          onBusy={onBusy}
          ownFile={surface.kind === "file" ? surface.filePath : undefined}
        />
      ))}
      {showChip && (
      <div className={`fn-chip fn-chip-${corner}`} onPointerDown={(e) => e.stopPropagation()} data-no-sidebar-swipe="true">
        {countOnly ? (
          notes.length > 0 && (
            <button
              className="fn-chip-count"
              title={`${notes.length} ${notes.length === 1 ? "note" : "notes"} - open NOTES`}
              onClick={() => host.app?.revealSidebarPanel?.("notes")}
            >
              <Icon name="note" /> {notes.length}
            </button>
          )
        ) : notes.length === 0 ? (
          <button
            className="fn-chip-btn"
            title={surface.kind === "file" ? "Add a note on this file" : "Add a note"}
            aria-label="Add a note"
            onClick={() => (surface.kind === "file" ? void add("file") : setAddMenu((v) => !v))}
          >
            <Icon name="note" />
          </button>
        ) : (
          <>
            <span className="fn-chip-label">
              <Icon name="note" /> Notes {notes.length}
            </span>
            <button
              className="fn-chip-btn"
              title="Add a note"
              aria-label="Add a note"
              onClick={() => (surface.kind === "file" ? void add("file") : setAddMenu((v) => !v))}
            >
              <Icon name="add" />
            </button>
            {data.hiddenAll ? (
              <button className="fn-chip-btn" title="Show this terminal's notes" onClick={() => void setHiddenAll(false)}>
                <Icon name="eye" /> Show
              </button>
            ) : (
              <button className="fn-chip-btn" title="Hide these notes" onClick={() => void setHiddenAll(true)}>
                <Icon name="eye-closed" /> Hide
              </button>
            )}
            {hiddenOne.length > 0 && !data.hiddenAll && (
              <button className="fn-chip-btn" title="Show the notes hidden one by one" onClick={() => void showAll()}>
                Show all
              </button>
            )}
          </>
        )}
        {addMenu && surface.kind === "window" && (
          <div className="fn-popup fn-menu fn-add-menu" role="menu">
            <button role="menuitem" onClick={() => void add("window")}>
              <Icon name="terminal" /> Note on this terminal
            </button>
            <button role="menuitem" onClick={() => void add("project")}>
              <Icon name="folder" /> Note on the project
            </button>
          </div>
        )}
        {error && <div className="fn-chip-error">{error}</div>}
      </div>
      )}
    </div>
  );
}

// ---- Accessory wrappers ----

interface TerminalAccessoryContext {
  mobilePointer: boolean;
  window?: { sessionName: string; windowIndex: number; windowId?: string } | null;
}

export function TerminalNotes({ context }: { context: TerminalAccessoryContext }) {
  if (!context.window) return null;
  return (
    <NotesLayer
      surface={{ kind: "window", sessionName: context.window.sessionName, windowIndex: context.window.windowIndex }}
      mobilePointer={context.mobilePointer}
      corner="top"
    />
  );
}

interface ViewerAccessoryContext {
  filePath: string;
  active: boolean;
  mobilePointer: boolean;
}

export function ViewerNotes({ context }: { context: ViewerAccessoryContext }) {
  // A global viewer with no file (agent-sessions://…, db-client://…) has no notes.
  if (!context.active || /^[a-z][a-z0-9+.-]*:\/\//i.test(context.filePath)) return null;
  return <NotesLayer surface={{ kind: "file", filePath: context.filePath }} mobilePointer={context.mobilePointer} corner="bottom" />;
}
