// The notes floating on the active terminal, for the two places that list
// them outside the terminal itself: the NOTES header's dropdown and the
// status-bar item. Both open the same menu (notesMenu): each note with a
// check for "card shown", then hide/show for the whole terminal, Show all,
// and adding a note.
import { useSyncExternalStore } from "react";
import { call, host, type ActiveContext } from "./host";
import { plainTitle } from "./plainTitle";
import { addNote, notesChanged, onNotesChanged, patchNote, type Note } from "./notesStore";

export interface ActiveFloat {
  sessionName: string | null;
  windowIndex: number | null;
  key: string | null;
  windowLabel: string | null;
  hiddenAll: boolean;
  notes: Note[];
  // The project's file notes (they float over their file's previews).
  files: Note[];
  projectRoot: string | null;
}

const EMPTY: ActiveFloat = {
  sessionName: null,
  windowIndex: null,
  key: null,
  windowLabel: null,
  hiddenAll: false,
  notes: [],
  files: [],
  projectRoot: null,
};

let state: ActiveFloat = EMPTY;
let context: ActiveContext = { sessionName: null, windowIndex: null, cwd: null };
const listeners = new Set<() => void>();
let offChanges: (() => void) | null = null;

function emit() {
  for (const l of listeners) l();
}

export async function refreshActive(): Promise<void> {
  const { sessionName, windowIndex } = context;
  if (!sessionName || windowIndex === null) {
    state = EMPTY;
    emit();
    return;
  }
  try {
    const d = await call<{ key: string | null; windowLabel?: string; hiddenAll: boolean; notes: Note[]; files?: Note[]; projectRoot?: string }>(
      `/float?session=${encodeURIComponent(sessionName)}&window=${windowIndex}`,
    );
    state = {
      sessionName,
      windowIndex,
      key: d.key,
      windowLabel: d.windowLabel ?? null,
      hiddenAll: d.hiddenAll,
      notes: d.notes,
      files: d.files ?? [],
      projectRoot: d.projectRoot ?? null,
    };
    emit();
  } catch {
    // keep the last answer
  }
}

export function setActiveContext(next: ActiveContext) {
  context = next;
  void refreshActive();
}

// Refetched on every change (the host's feed calls notesChanged()), not polled.
export function startActive() {
  if (offChanges) return;
  offChanges = onNotesChanged(() => void refreshActive());
}

export function stopActive() {
  offChanges?.();
  offChanges = null;
  listeners.clear();
  state = EMPTY;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useActiveFloat(): ActiveFloat {
  return useSyncExternalStore(subscribe, () => state);
}

const titleOf = (note: Note) => plainTitle(note.body, 48);

export interface MenuItem {
  label: string;
  onClick: () => void;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  icon?: string;
  // A secondary action button at the row's end (the host menu's `trailing`).
  trailing?: { icon: string; title: string; onClick: () => void };
  danger?: boolean;
  // A row of colour swatches (the host menu's `swatches`).
  swatches?: { colors: { key: string; hex: string }[]; selected: string; onPick: (key: string) => void };
}

export async function setHiddenAll(hidden: boolean) {
  if (!state.key) return;
  await call("/surface", { method: "PUT", body: JSON.stringify({ key: state.key, hidden }) });
  notesChanged();
}

// Every card on the active terminal shown again: ones hidden one by one,
// and the terminal's own Hide.
export async function showAll(): Promise<void> {
  const s = state;
  const ids = [...s.notes, ...s.files].filter((n) => n.hidden).map((n) => n.id);
  if (ids.length) await call("/show-all", { method: "POST", body: JSON.stringify({ ids }) });
  if (s.hiddenAll) await setHiddenAll(false);
  notesChanged();
}

// The NOTES header's eye menu: hide or show every card on the terminal.
export function cardsMenu(): MenuItem[] {
  const s = state;
  if (!s.sessionName || !s.key) return [{ label: "Open a terminal to see its notes", disabled: true, onClick: () => {} }];
  const someHidden = [...s.notes, ...s.files].some((n) => n.hidden);
  const items: MenuItem[] = [
    s.hiddenAll
      ? { label: "Show Cards on This Terminal", icon: "eye", onClick: () => void setHiddenAll(false) }
      : { label: "Hide Cards on This Terminal", icon: "eye-closed", onClick: () => void setHiddenAll(true) },
  ];
  if (someHidden || s.hiddenAll) items.push({ label: "Show All", icon: "eye", onClick: () => void showAll() });
  return items;
}

// The dropdown for the active terminal.
export function notesMenu(): MenuItem[] {
  const s = state;
  if (!s.sessionName || !s.key) {
    return [{ label: "Open a terminal to see its notes", disabled: true, onClick: () => {} }];
  }
  const items: MenuItem[] = [];
  const terminal = s.notes.filter((n) => n.scope === "window");
  const project = s.notes.filter((n) => n.scope === "project");
  const row = (n: Note): MenuItem => ({
    label: titleOf(n),
    checked: !n.hidden,
    onClick: () => void patchNote(n.id, { hidden: !n.hidden }),
  });
  if (terminal.length) {
    items.push({ label: "This terminal", disabled: true, onClick: () => {} }, ...terminal.map(row));
  }
  if (project.length) {
    if (items.length) items.push({ label: "", separator: true, onClick: () => {} });
    items.push({ label: "This project", disabled: true, onClick: () => {} }, ...project.map(row));
  }
  if (!items.length) items.push({ label: "No notes on this terminal yet", disabled: true, onClick: () => {} });
  // The project's file notes: each one's card floats over that file's
  // previews; Open goes there.
  if (s.files.length) {
    const rel = (p: string) => (s.projectRoot && p.startsWith(s.projectRoot + "/") ? p.slice(s.projectRoot.length + 1) : p);
    items.push({ label: "", separator: true, onClick: () => {} }, { label: "Files in this project", disabled: true, onClick: () => {} });
    for (const n of s.files) {
      const file = rel(n.filePath ?? "");
      items.push({
        label: `${file.split("/").pop()}: ${titleOf(n)}`,
        checked: !n.hidden,
        onClick: () => void patchNote(n.id, { hidden: !n.hidden }),
        trailing: { icon: "go-to-file", title: `Open ${file}`, onClick: () => host.app?.openPreview?.(n.filePath ?? "") },
      });
    }
  }
  items.push({ label: "", separator: true, onClick: () => {} });
  const someHidden = s.notes.some((n) => n.hidden) || s.files.some((n) => n.hidden);
  if (s.notes.length) {
    items.push(
      s.hiddenAll
        ? { label: "Show Cards on This Terminal", icon: "eye", onClick: () => void setHiddenAll(false) }
        : { label: "Hide Cards on This Terminal", icon: "eye-closed", onClick: () => void setHiddenAll(true) },
    );
  }
  if (someHidden || s.hiddenAll) {
    items.push({ label: "Show All", icon: "eye", onClick: () => void showAll() });
  }
  items.push(
    { label: "Add Note to This Terminal", icon: "add", onClick: () => void addNote("window").catch(() => {}) },
    { label: "Add Note to the Project", icon: "add", onClick: () => void addNote("project").catch(() => {}) },
  );
  return items;
}

export function openNotesMenu(anchor: DOMRect, showMenu?: (x: number, y: number, items: MenuItem[]) => void) {
  void refreshActive().then(() => showMenu?.(anchor.left, anchor.bottom, notesMenu()));
}

