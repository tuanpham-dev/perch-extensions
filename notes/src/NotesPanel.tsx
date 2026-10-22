import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { host } from "./host";
import { plainTitle } from "./plainTitle";
import { BodySaver } from "./bodySaver";
import { MARKDOWN_COMPONENTS, textItems, useContextMenu } from "./NoteLink";
import { cardsMenu, useActiveFloat, type MenuItem as NotesMenuItem } from "./activeFloat";
import {
  addNote,
  editCard,
  NOTE_COLORS,
  patchNote,
  peekFocusId,
  reattach,
  removeNote,
  saveBody,
  takeFocusId,
  useNotesView,
  type Note,
} from "./notesStore";

const SAVE_DELAY_MS = 800;


function relativeTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

const titleOf = (note: Note) => plainTitle(note.body);

// The card colours, for the host menu's swatch row (same hues as style.css).
const COLOR_HEX: Record<string, string> = {
  yellow: "#e8c13a",
  green: "#4cc27a",
  blue: "#4f93e8",
  pink: "#e8628f",
  purple: "#9a6be8",
  grey: "#8b939b",
};

async function deleteNote(note: Note): Promise<void> {
  if (note.body.trim() && !(await host.app?.confirmDialog?.(`Delete the note "${titleOf(note)}"?`, "Delete"))) return;
  await removeNote(note.id);
}

type ShowMenu = (x: number, y: number, items: NotesMenuItem[]) => void;

function relativeTo(root: string | null, file: string): string {
  if (!root) return file;
  const r = root.replace(/\/+$/, "");
  return file.startsWith(r + "/") ? file.slice(r.length + 1) : file;
}

async function pickWindow(): Promise<{ session: string; window: number } | null> {
  const res = await fetch("/api/sessions");
  const sessions = (await res.json()) as { name: string; path: string; windows: { index: number; name: string }[] }[];
  const items = sessions
    .filter((s) => !s.name.startsWith("perch-view-"))
    .flatMap((s) =>
      s.windows.map((w) => ({
        id: `${s.name}\u0000${w.index}`,
        label: `${s.path.split("/").pop() || s.name} · ${w.name}`,
        icon: "terminal",
      })),
    );
  const id = await host.app?.pickItem?.({ title: "Reattach to terminal", items, placeholder: "Pick a terminal" });
  if (!id) return null;
  const [session, index] = id.split("\u0000");
  return { session, window: Number(index) };
}

async function pickFile(root: string): Promise<string | null> {
  const res = await fetch(`/api/fs/files?path=${encodeURIComponent(root)}`);
  if (!res.ok) return null;
  const listing = (await res.json()) as { path: string; files: string[] };
  const base = listing.path.replace(/\/+$/, "");
  const items = listing.files.slice(0, 5000).map((f) => ({ id: `${base}/${f}`, label: f, icon: "file" }));
  return (await host.app?.pickItem?.({ title: "Reattach to file", items, placeholder: "Pick a file" })) ?? null;
}

function NoteItem({ note, projectRoot, label }: { note: Note; projectRoot: string | null; label?: string }) {
  const [open, setOpen] = useState(() => peekFocusId() === note.id);
  const [editing, setEditing] = useState(() => peekFocusId() === note.id || note.body === "");
  const [text, setText] = useState(note.body);
  const [error, setError] = useState<string | null>(null);
  const [swatches, setSwatches] = useState(false);
  const timer = useRef<number | null>(null);
  const saver = useRef<BodySaver | null>(null);
  saver.current ??= new BodySaver((body) => saveBody(note.id, body), note.body);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const contextMenu = useContextMenu();

  // A note the panel was asked to show (new, or from a badge): open it.
  useEffect(() => {
    if (peekFocusId() === note.id) {
      takeFocusId();
      setOpen(true);
      setEditing(true);
      requestAnimationFrame(() => textRef.current?.focus());
    }
  });

  // Another device's edit arrives through the poll; take it unless this one
  // has unsaved typing of its own.
  useEffect(() => {
    if (saver.current?.external(note.body)) setText(note.body);
  }, [note.body]);

  // Saves whatever is typed now. Typing that lands while this save is in
  // flight keeps the note dirty, so it gets saved too.
  const flush = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    saver.current
      ?.flush()
      .then(() => setError(null))
      .catch((err: Error) => setError(err.message));
  };

  useEffect(
    () => () => {
      if (saver.current?.dirty) flush();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onChange = (value: string) => {
    setText(value);
    saver.current?.edit(value);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
  };

  const remove = () => deleteNote(note).catch((err: Error) => setError(err.message));

  const doReattach = async () => {
    try {
      if (note.scope === "window") {
        const target = await pickWindow();
        if (target) await reattach(note.id, { reattachWindow: target });
      } else if (note.scope === "file" && projectRoot) {
        const file = await pickFile(projectRoot);
        if (file) await reattach(note.id, { reattachFile: file });
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className={`notes-item fn-${note.color ?? "yellow"}${open ? " open" : ""}`}>
      <button className="notes-item-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`codicon codicon-chevron-${open ? "down" : "right"}`} aria-hidden="true" />
        <span className="notes-item-title">{label ? <span className="notes-item-label">{label} · </span> : null}{titleOf({ ...note, body: text })}</span>
        {note.hidden && (
          <span className="notes-item-hidden" title="Its card is hidden">
            <span className="codicon codicon-eye-closed" aria-hidden="true" />
          </span>
        )}
        <span className="notes-item-time">{relativeTime(note.updatedAt)}</span>
      </button>
      {note.detached && (
        <div className="notes-item-actions">
          <button onClick={doReattach}>Reattach…</button>
          <button onClick={remove}>Delete</button>
        </div>
      )}
      {open && (
        <div className="notes-item-body">
          <div className="notes-item-toolbar">
            <button className={editing ? "active" : ""} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className={editing ? "" : "active"} onClick={() => setEditing(false)}>
              Preview
            </button>
            {note.scope === "file" && note.filePath && !note.detached && (
              <button onClick={() => host.app?.openFileTab?.(note.filePath!)}>Open File</button>
            )}
            <button title="Change colour" aria-label="Change colour" onClick={() => setSwatches((v) => !v)}>
              <span className="codicon codicon-symbol-color" aria-hidden="true" />
            </button>
            {note.hidden && !note.detached && (
              <button onClick={() => patchNote(note.id, { hidden: false }).catch((err: Error) => setError(err.message))}>
                <span className="codicon codicon-eye" aria-hidden="true" /> Show card
              </button>
            )}
            <span className="notes-spacer" />
            {!note.detached && (
              <button title="Delete note" aria-label="Delete note" onClick={remove}>
                <span className="codicon codicon-trash" aria-hidden="true" />
              </button>
            )}
          </div>
          {swatches && (
            <div className="notes-swatches" role="menu" aria-label="Colour">
              {NOTE_COLORS.map((c) => (
                <button
                  key={c}
                  role="menuitemradio"
                  aria-checked={(note.color ?? "yellow") === c}
                  title={c[0].toUpperCase() + c.slice(1)}
                  className={`fn-swatch fn-${c}${(note.color ?? "yellow") === c ? " current" : ""}`}
                  onClick={() => {
                    setSwatches(false);
                    patchNote(note.id, { color: c }).catch((err: Error) => setError(err.message));
                  }}
                />
              ))}
            </div>
          )}
          {editing ? (
            <textarea
              ref={textRef}
              className="notes-editor"
              value={text}
              placeholder="Write in Markdown…"
              onChange={(e) => onChange(e.target.value)}
              onBlur={() => saver.current?.dirty && flush()}
              onKeyDown={(e) => e.stopPropagation()}
              rows={Math.min(16, Math.max(4, text.split("\n").length + 1))}
            />
          ) : (
            <div
              className="notes-preview"
              onDoubleClick={() => setEditing(true)}
              onContextMenu={(e) =>
                contextMenu.open(e, [
                  ...textItems(e.target, e.currentTarget),
                  { label: "", separator: true },
                  { label: "Edit", icon: "edit", onClick: () => setEditing(true) },
                ])
              }
              title="Double-click to edit"
            >
              {text.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={MARKDOWN_COMPONENTS}>
                  {text}
                </ReactMarkdown>
              ) : (
                <span className="notes-muted">Empty note</span>
              )}
            </div>
          )}
          {error && <div className="notes-error">Couldn't save: {error}</div>}
          {contextMenu.element}
        </div>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="notes-group" role="group" aria-label={title}>
      <div className="notes-group-head">
        <span className="notes-group-title">{title}</span>
      </div>
      {children}
    </div>
  );
}

// One note as a row, the way the menus list it: a check while its card shows
// (click the row to hide or show the card), its colour, its title, an Open
// button for a file note and a Delete button. Right-click for the rest. The
// note itself is read and edited on its card.
function NoteRow({ note, label, onOpen, showMenu }: { note: Note; label?: string; onOpen?: () => void; showMenu?: ShowMenu }) {
  const [error, setError] = useState<string | null>(null);
  const shown = !note.hidden;
  const fail = (err: Error) => setError(err.message);

  const menu = (x: number, y: number) =>
    showMenu?.(x, y, [
      shown
        ? { label: "Hide Card", icon: "eye-closed", onClick: () => void patchNote(note.id, { hidden: true }).catch(fail) }
        : { label: "Show Card", icon: "eye", onClick: () => void patchNote(note.id, { hidden: false }).catch(fail) },
      { label: "Edit", icon: "edit", onClick: () => void editCard(note).catch(fail) },
      ...(onOpen ? [{ label: "Open File", icon: "go-to-file", onClick: onOpen }] : []),
      { label: "", separator: true, onClick: () => {} },
      {
        label: "Colour",
        onClick: () => {},
        swatches: {
          colors: NOTE_COLORS.map((c) => ({ key: c, hex: COLOR_HEX[c] })),
          selected: note.color ?? "yellow",
          onPick: (c) => void patchNote(note.id, { color: c as Note["color"] }).catch(fail),
        },
      },
      { label: "", separator: true, onClick: () => {} },
      { label: "Delete…", icon: "trash", danger: true, onClick: () => void deleteNote(note).catch(fail) },
    ]);

  return (
    <div
      className={`notes-row fn-${note.color ?? "yellow"}`}
      onContextMenu={(e) => {
        if (!showMenu) return;
        e.preventDefault();
        menu(e.clientX, e.clientY);
      }}
    >
      <button
        className="notes-row-main"
        role="menuitemcheckbox"
        aria-checked={shown}
        title={shown ? "Card showing - click to hide it" : "Card hidden - click to show it"}
        onClick={() => patchNote(note.id, { hidden: shown }).catch(fail)}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            menu(r.left + 16, r.bottom);
          }
        }}
      >
        <span className="notes-row-check">{shown && <span className="codicon codicon-check" aria-hidden="true" />}</span>
        <span className="notes-row-dot" aria-hidden="true" />
        <span className="notes-row-title">
          {label && <span className="notes-item-label">{label}: </span>}
          {titleOf(note)}
        </span>
      </button>
      {onOpen && (
        <button className="notes-row-trailing" title={`Open ${label ?? "file"}`} aria-label={`Open ${label ?? "file"}`} onClick={onOpen}>
          <span className="codicon codicon-go-to-file" aria-hidden="true" />
        </button>
      )}
      <button className="notes-row-trailing" title="Delete note" aria-label="Delete note" onClick={() => void deleteNote(note).catch(fail)}>
        <span className="codicon codicon-trash" aria-hidden="true" />
      </button>
      {error && <div className="notes-error notes-pad">{error}</div>}
    </div>
  );
}

const isPhone = () => window.matchMedia("(pointer: coarse) and (hover: none)").matches;

export function NotesPanel({
  actionsTarget,
  showMenu,
}: {
  actionsTarget?: HTMLDivElement | null;
  showMenu?: ShowMenu;
}) {
  const active = useActiveFloat();
  const view = useNotesView();
  const [error, setError] = useState<string | null>(null);
  const phone = isPhone();
  const add = (scope: "project" | "window") => addNote(scope).catch((err: Error) => setError(err.message));
  const root = active.projectRoot ?? view.projectRoot ?? null;
  const hasTerminal = Boolean(active.sessionName && active.key);

  // The eye opens the show/hide choices; + opens the add choices, the way the
  // corner chip's + does.
  const actions = actionsTarget
    ? createPortal(
        <>
        {!phone && (
          <button
            className="icon-button"
            title="Show or Hide Cards"
            aria-label="Show or hide cards"
            aria-haspopup="menu"
            data-menu-trigger="true"
            disabled={!hasTerminal}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              showMenu?.(r.left, r.bottom, cardsMenu());
            }}
          >
            <span className={`codicon codicon-${active.hiddenAll ? "eye-closed" : "eye"}`} aria-hidden="true" />
          </button>
        )}
        <button
          className="icon-button"
          title="Add Note"
          aria-label="Add note"
          aria-haspopup="menu"
          data-menu-trigger="true"
          disabled={!hasTerminal}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu?.(r.left, r.bottom, [
              { label: "Add Note to This Terminal", icon: "terminal", onClick: () => void add("window") },
              { label: "Add Note to the Project", icon: "folder", onClick: () => void add("project") },
            ]);
          }}
        >
          <span className="codicon codicon-add" aria-hidden="true" />
        </button>
        </>,
        actionsTarget,
      )
    : null;

  if (!hasTerminal) {
    return (
      <div className="notes">
        {actions}
        <div className="notes-empty">Open a terminal to see its project's notes.</div>
      </div>
    );
  }

  const terminal = active.notes.filter((n) => n.scope === "window");
  const project = active.notes.filter((n) => n.scope === "project");
  const files = active.files;
  const detached = view.notes.filter((n) => n.detached);
  const any = terminal.length + project.length + files.length > 0;

  // Phones draw no cards, so there a note opens in the list instead.
  const row = (n: Note, label?: string, onOpen?: () => void) =>
    phone ? (
      <NoteItem key={n.id} note={n} projectRoot={root} label={label} />
    ) : (
      <NoteRow key={n.id} note={n} label={label} onOpen={onOpen} showMenu={showMenu} />
    );

  return (
    <div className="notes" role="menu" aria-label="Notes on this terminal">
      {actions}
      {!any && <div className="notes-empty">No notes on this terminal yet. Add one with +.</div>}
      {terminal.length > 0 && <Group title="This terminal">{terminal.map((n) => row(n))}</Group>}
      {project.length > 0 && <Group title="This project">{project.map((n) => row(n))}</Group>}
      {files.length > 0 && (
        <Group title="Files in this project">
          {files.map((n) => {
            const file = n.relPath ?? relativeTo(root, n.filePath ?? "");
            return row(n, file, () => host.app?.openPreview?.(n.filePath ?? ""));
          })}
        </Group>
      )}
      {detached.length > 0 && (
        <Group title={`Detached (${detached.length})`}>
          {detached.map((n) => (
            <NoteItem
              key={n.id}
              note={n}
              projectRoot={root}
              label={n.scope === "window" ? n.windowLabel : relativeTo(root, n.filePath ?? "")}
            />
          ))}
        </Group>
      )}
      {error && <div className="notes-error notes-pad">{error}</div>}
    </div>
  );
}
