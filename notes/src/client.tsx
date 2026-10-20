// Notes: private Markdown notes on a project, a terminal or a file. A NOTES
// section in the Explorer shows the active project's; badges mark the
// terminals and files that have any. The server hook keeps them (see
// ../server.js); this side only renders and edits.
import { host, type AppApi, type StorageApi } from "./host";
import { injectStylesheet } from "./injectStylesheet";
import { NotesPanel } from "./NotesPanel";
import { TerminalNotes, ViewerNotes } from "./FloatingNotes";
import { notesMenu, refreshActive, setActiveContext, startActive, stopActive, useActiveFloat } from "./activeFloat";
import { initSettings, type SettingsApi } from "./settings";
import {
  addNote,
  currentContext,
  filesRenamed,
  getMarks,
  notesChanged,
  onMarksChange,
  refresh,
  refreshMarks,
  setContext,
  startWatching,
  stopWatching,
} from "./notesStore";
import "./style.css";

interface DecorationContext {
  sessionName: string;
  windowIndex: number;
}

interface ExtensionContext {
  app: AppApi;
  storage?: StorageApi;
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  registerCommand(cmd: { id: string; label: string; run: () => void }): void;
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location?: "tab" | "explorer" | "run" | "commands";
    order?: number;
    component: typeof NotesPanel;
  }): void;
  registerFileMenuItem(item: {
    id: string;
    label: string;
    icon?: string;
    order?: number;
    isVisible: (path: string, isDir: boolean) => boolean;
    onClick: (path: string) => void;
  }): void;
  registerSessionDecorationProvider(provider: {
    id: string;
    provideWindowDecoration: (ctx: DecorationContext) => { badge: string; icon?: string; tooltip?: string; className?: string } | undefined;
    onClick?: (rect: DOMRect, ctx: DecorationContext) => void;
  }): { refresh(): void };
  registerFileDecorationProvider(provider: {
    id: string;
    provideDecoration: (path: string, isDir: boolean) => { badge?: string; icon?: string; tooltip?: string; className?: string } | undefined;
  }): { refresh(): void };
  registerTerminalAccessory?(accessory: { id: string; placement: "bar" | "overlay"; component: typeof TerminalNotes }): void;
  registerStatusBarItem?(item: {
    id: string;
    title?: string;
    placement?: "left" | "right";
    order?: number;
    visibilitySetting?: string;
    component: typeof NotesStatusItem;
  }): void;
  settings: SettingsApi;
  registerViewerAccessory?(accessory: { id: string; component: typeof ViewerNotes }): void;
}

const cleanups: Array<() => void> = [];
let removeStylesheet: (() => void) | null = null;

const plural = (n: number) => (n === 1 ? "1 note" : `${n} notes`);

// The status-bar item's popover: the same rows as the NOTES section's eye
// menu (notesMenu), live, so a toggled card's check updates in place. Adding
// a note closes it.
function NotesPopover({ onClose }: { onClose: () => void }) {
  useActiveFloat(); // re-render on every change to the active terminal's notes
  const items = notesMenu();
  return (
    <div className="notes-popover" role="menu" aria-label="Notes on this terminal">
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="notes-popover-sep" role="separator" />
        ) : item.disabled ? (
          <div key={i} className="notes-popover-heading">
            {item.label}
          </div>
        ) : (
          <div key={i} className="notes-popover-line">
            <button
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={item.checked}
              className="notes-popover-row"
              onClick={() => {
                item.onClick();
                if (item.icon === "add") onClose();
              }}
            >
              <span className="notes-popover-gutter">
                {item.checked ? (
                  <span className="codicon codicon-check" aria-hidden="true" />
                ) : item.icon ? (
                  <span className={`codicon codicon-${item.icon}`} aria-hidden="true" />
                ) : null}
              </span>
              <span className="notes-popover-label">{item.label}</span>
            </button>
            {item.trailing && (
              <button
                className="notes-popover-trailing"
                title={item.trailing.title}
                aria-label={item.trailing.title}
                onClick={() => {
                  item.trailing!.onClick();
                  onClose();
                }}
              >
                <span className={`codicon codicon-${item.trailing.icon}`} aria-hidden="true" />
              </button>
            )}
          </div>
        ),
      )}
    </div>
  );
}

// The status-bar item: the count of notes floating on the active terminal
// (shown/total when some cards are hidden). Opens NotesPopover above the
// bar, the way other status-bar items open theirs.
function NotesStatusItem({
  context,
}: {
  context: { mobilePointer: boolean; openPopover(anchor: DOMRect, content: React.ReactNode): void; closePopover(): void };
}) {
  const active = useActiveFloat();
  if (!active.sessionName) return null;
  const total = active.notes.length;
  const shown = active.hiddenAll ? 0 : active.notes.filter((n) => !n.hidden).length;
  const title =
    total === 0
      ? "No notes on this terminal - click to add one"
      : `${plural(total)} on this terminal${shown < total ? `, ${shown} showing` : ""} - click to show or hide them`;
  return (
    <button
      className="status-bar-item notes-status-item"
      data-menu-trigger="true"
      aria-haspopup="menu"
      title={title}
      onClick={(e) => {
        void refreshActive();
        context.openPopover(e.currentTarget.getBoundingClientRect(), <NotesPopover onClose={() => context.closePopover()} />);
      }}
    >
      <span className="codicon codicon-note" aria-hidden="true" />
      {total > 0 && <span>{shown < total ? `${shown}/${total}` : total}</span>}
    </button>
  );
}

// Shown in place of the NOTES list on a Perch without extension storage.
function NeedsNewerPerch() {
  return <div className="notes-empty">Notes needs Perch 0.9 or newer. Update Perch to use it.</div>;
}

export function activate(ctx: ExtensionContext): void {
  if (!ctx.storage) {
    ctx.registerSidebarPanel({ id: "notes", title: "NOTES", icon: "note", location: "explorer", order: 30, component: NeedsNewerPerch as typeof NotesPanel });
    return;
  }
  host.app = ctx.app;
  host.serverFetch = ctx.serverFetch;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  setContext(ctx.app.getActiveContext());
  setActiveContext(ctx.app.getActiveContext());
  cleanups.push(
    ctx.app.onDidChangeContext((c) => {
      setContext(c);
      setActiveContext(c);
    }),
  );
  // Every write to the notes, from any browser or device, arrives here; the
  // pane, the badges, the status item and the cards all refetch on it. A
  // resync (the server restarted, or the notes were deleted in Settings)
  // means changes may have been missed, which a refetch also covers.
  for (const name of ["notes", "surfaces"]) cleanups.push(ctx.storage.collection(name).subscribe(() => notesChanged()));
  startWatching();
  startActive();
  cleanups.push(initSettings(ctx.settings));

  ctx.registerSidebarPanel({ id: "notes", title: "NOTES", icon: "note", location: "explorer", order: 30, component: NotesPanel });

  ctx.registerStatusBarItem?.({
    id: "notes",
    title: "Notes",
    placement: "right",
    order: 5,
    visibilitySetting: "notes.showStatusBar",
    component: NotesStatusItem,
  });

  ctx.registerCommand({ id: "addToTerminal", label: "Notes: Add Note to Terminal", run: () => void addNote("window").catch(() => {}) });
  ctx.registerCommand({ id: "addToProject", label: "Notes: Add Note to Project", run: () => void addNote("project").catch(() => {}) });
  ctx.registerCommand({
    id: "show",
    label: "Notes: Show Notes",
    run: () => {
      void refresh();
      ctx.app.revealSidebarPanel?.("notes");
    },
  });

  ctx.registerFileMenuItem({
    id: "add",
    label: "Add Note",
    icon: "note",
    order: 50,
    isVisible: (_path, isDir) => !isDir && Boolean(currentContext().sessionName),
    onClick: (path) => void addNote("file", path).catch(() => {}),
  });
  ctx.registerFileMenuItem({
    id: "showFile",
    label: "Show Notes",
    icon: "note",
    order: 51,
    isVisible: (path, isDir) => !isDir && Boolean(getMarks().files[path]),
    onClick: () => {
      void refresh();
      ctx.app.revealSidebarPanel?.("notes");
    },
  });

  const windowBadges = ctx.registerSessionDecorationProvider({
    id: "notes",
    provideWindowDecoration: ({ sessionName, windowIndex }) => {
      const mark = getMarks().windows.find((w) => w.sessionName === sessionName && w.windowIndex === windowIndex);
      return mark ? { badge: "", icon: "note", tooltip: `${plural(mark.count)} on this terminal`, className: "notes-badge" } : undefined;
    },
    // The NOTES section shows the focused terminal's notes, so open that
    // terminal first, then the section.
    onClick: (_rect, { sessionName, windowIndex }) => {
      ctx.app.openSessionWindow?.(sessionName, { windowIndex });
      ctx.app.revealSidebarPanel?.("notes");
    },
  });
  const fileBadges = ctx.registerFileDecorationProvider({
    id: "notes",
    provideDecoration: (path, isDir) => {
      const count = isDir ? 0 : getMarks().files[path];
      return count ? { badge: "", icon: "note", tooltip: `${plural(count)} - right-click › Show Notes`, className: "notes-file-row" } : undefined;
    },
  });
  cleanups.push(
    onMarksChange(() => {
      windowBadges.refresh();
      fileBadges.refresh();
    }),
  );

  // Notes as cards floating over their terminal and their file's previews
  // (hosts from Perch 0.9 on; older ones keep the sidebar only).
  ctx.registerTerminalAccessory?.({ id: "cards", placement: "overlay", component: TerminalNotes });
  ctx.registerViewerAccessory?.({ id: "cards", component: ViewerNotes });

  if (ctx.app.onDidRenameFiles) cleanups.push(ctx.app.onDidRenameFiles((pairs) => void filesRenamed(pairs)));
  void refreshMarks();
}

export function deactivate(): void {
  for (const fn of cleanups.splice(0)) fn();
  stopWatching();
  stopActive();
  removeStylesheet?.();
  removeStylesheet = null;
  host.app = null;
  host.serverFetch = null;
}
