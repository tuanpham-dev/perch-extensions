// What the NOTES section shows, shared by the panel, the commands and the
// badges: the active session's notes, and which windows and files have any.
import { useSyncExternalStore } from "react";
import { call, host, type ActiveContext } from "./host";

export type Scope = "project" | "window" | "file";
export type NoteColor = "yellow" | "green" | "blue" | "pink" | "purple" | "grey";
export const NOTE_COLORS: NoteColor[] = ["yellow", "green", "blue", "pink", "purple", "grey"];

// Anything that changed a note tells everything showing notes (the library,
// floating cards) to refetch now rather than at the next poll.
const changeListeners = new Set<() => void>();
export function onNotesChanged(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}
export function notesChanged(): void {
  for (const l of changeListeners) l();
}

export interface Note {
  id: string;
  scope: Scope;
  projectPath: string;
  windowId?: string;
  windowLabel?: string;
  filePath?: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  detached: boolean;
  color?: NoteColor;
  layout?: { x: number; y: number; w: number; h: number };
  hidden?: boolean;
  // File notes, from /float: the file's path inside its project.
  relPath?: string;
}

export interface NotesView {
  projectPath: string | null;
  projectRoot?: string;
  windowId: string | null;
  windowLabel: string | null;
  notes: Note[];
}

export interface Marks {
  windows: { sessionName: string; windowIndex: number; count: number }[];
  files: Record<string, number>;
}

let view: NotesView = { projectPath: null, windowId: null, windowLabel: null, notes: [] };
let marks: Marks = { windows: [], files: {} };
let context: ActiveContext = { sessionName: null, windowIndex: null, cwd: null };
const listeners = new Set<() => void>();
const markListeners = new Set<() => void>();
let started = false;
// The note the panel should open in edit mode once it appears (a new one, or
// one a badge or menu item asked for).
let focusId: string | null = null;

function emit() {
  for (const l of listeners) l();
}

export function setContext(next: ActiveContext) {
  context = next;
  void refresh();
}

export function currentContext(): ActiveContext {
  return context;
}

export async function refresh(): Promise<void> {
  if (!context.sessionName) {
    view = { projectPath: null, windowId: null, windowLabel: null, notes: [] };
    emit();
    return;
  }
  const q = `?session=${encodeURIComponent(context.sessionName)}&window=${context.windowIndex ?? ""}`;
  try {
    view = await call<NotesView>(`/notes${q}`);
    emit();
  } catch {
    // keep the last view; the next change tries again
  }
}

export async function refreshMarks(): Promise<void> {
  try {
    marks = await call<Marks>("/marks");
    for (const l of markListeners) l();
  } catch {
    // badges keep their last answer
  }
}

export function getMarks(): Marks {
  return marks;
}

export function onMarksChange(cb: () => void): () => void {
  markListeners.add(cb);
  return () => markListeners.delete(cb);
}

let unsubscribeChanges: (() => void) | null = null;

// No timer: the host's change feed calls notesChanged() on every write
// (client.tsx), and this refetches on it.
export function startWatching() {
  if (started) return;
  started = true;
  unsubscribeChanges ??= onNotesChanged(() => {
    void refresh();
    void refreshMarks();
  });
  void refreshMarks();
}

export function stopWatching() {
  started = false;
  unsubscribeChanges?.();
  unsubscribeChanges = null;
  listeners.clear();
  markListeners.clear();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useNotesView(): NotesView {
  return useSyncExternalStore(subscribe, () => view);
}

export function takeFocusId(): string | null {
  const id = focusId;
  focusId = null;
  return id;
}

export function peekFocusId(): string | null {
  return focusId;
}

export function requestFocus(id: string) {
  focusId = id;
  emit();
}

export async function addNote(scope: Scope, filePath?: string): Promise<Note | null> {
  if (!context.sessionName) return null;
  const note = await call<Note>("/notes", {
    method: "POST",
    body: JSON.stringify({ session: context.sessionName, window: context.windowIndex, scope, filePath, body: "" }),
  });
  // Its card opens ready for typing, wherever it floats (see
  // FloatingNotes); on a phone, with no cards, the NOTES list opens it.
  pendingCardEdit = note.id;
  requestFocus(note.id);
  await Promise.all([refresh(), refreshMarks()]);
  notesChanged();
  return note;
}

// The note whose card should open in edit mode the next time it's drawn.
let pendingCardEdit: string | null = null;

export function peekPendingCardEdit(): string | null {
  return pendingCardEdit;
}

export function clearPendingCardEdit(id: string): void {
  if (pendingCardEdit === id) pendingCardEdit = null;
}

// Opens a note's card ready for typing: shown again if it was hidden.
export async function editCard(note: Note): Promise<void> {
  pendingCardEdit = note.id;
  if (note.hidden) await patchNote(note.id, { hidden: false });
  else notesChanged();
}

export async function saveBody(id: string, body: string): Promise<void> {
  await call(`/notes/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ body }) });
  notesChanged();
  // Patched in place: refetching here would replace the textarea's value
  // with an older answer while the user keeps typing.
  view = { ...view, notes: view.notes.map((n) => (n.id === id ? { ...n, body, updatedAt: Date.now() } : n)) };
  emit();
}

export async function removeNote(id: string): Promise<void> {
  await call(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  await Promise.all([refresh(), refreshMarks()]);
  notesChanged();
}

// A note's colour, card box or hidden flag.
export async function patchNote(
  id: string,
  patch: { color?: NoteColor; layout?: Note["layout"] | null; hidden?: boolean },
): Promise<void> {
  await call(`/notes/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(patch) });
  view = { ...view, notes: view.notes.map((n) => (n.id === id ? { ...n, ...patch, layout: patch.layout === null ? undefined : (patch.layout ?? n.layout) } : n)) };
  emit();
  notesChanged();
}

export async function reattach(id: string, target: { reattachWindow?: { session: string; window: number }; reattachFile?: string }) {
  await call(`/notes/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(target) });
  await Promise.all([refresh(), refreshMarks()]);
  notesChanged();
}

export async function filesRenamed(pairs: { from: string; to: string }[]) {
  try {
    const { moved } = await call<{ moved: number }>("/notes/rename", { method: "POST", body: JSON.stringify({ pairs }) });
    if (moved > 0) {
      await Promise.all([refresh(), refreshMarks()]);
      notesChanged();
    }
  } catch {
    // the note stays on the old path and shows as detached; Reattach fixes it
  }
}
