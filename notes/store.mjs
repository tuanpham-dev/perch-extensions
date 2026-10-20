// The notes' durable store, on the host's extension storage (Perch 0.9+,
// activate({ storage })): collection "notes" holds one record per note, keyed
// by id, and collection "surfaces" one record per terminal or file preview
// whose cards are all hidden. Each write is one storage transaction, so two
// browsers saving at once can't drop each other's edit, and every write is
// announced to open browsers, which is how the cards and the NOTES pane hear
// about changes.
//
// A note is
//   { id, scope: "project" | "window" | "file", projectPath,
//     windowId?, windowLabel?, filePath?, body, createdAt, updatedAt,
//     color?, layout?: { x, y, w, h }, hidden? }
// layout is the floating card's box as shares (0..1) of the area it floats
// in, so it holds across resizes and devices; hidden hides its card
// everywhere. A surface key ("window:<id>" or "file:<path>") records that
// every card on that terminal or file preview is hidden.
//
// projectPath is the session's own path (the folder it started in, which
// never moves), windowId the stable window id ($PERCH_WINDOW), so both
// survive server and daemon restarts. filePath is absolute.
import { randomBytes } from "node:crypto";
import path from "node:path";

export const SCOPES = ["project", "window", "file"];
export const COLORS = ["yellow", "green", "blue", "pink", "purple", "grey"];

// A card box from a client, clamped into the area, or null when unusable.
export function cleanLayout(raw) {
  if (!raw || typeof raw !== "object") return null;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  let { x, y, w, h } = { x: n(raw.x), y: n(raw.y), w: n(raw.w), h: n(raw.h) };
  if ([x, y, w, h].some(Number.isNaN)) return null;
  w = Math.min(1, Math.max(0.05, w));
  h = Math.min(1, Math.max(0.05, h));
  x = Math.min(1 - w, Math.max(0, x));
  y = Math.min(1 - h, Math.max(0, y));
  const r = (v) => Math.round(v * 10000) / 10000;
  return { x: r(x), y: r(y), w: r(w), h: r(h) };
}
export const MAX_BODY = 256 * 1024;

export function newNoteId() {
  return `note_${randomBytes(6).toString("hex")}`;
}

// Where `p` lands after `from` moved to `to`: the same path when it was the
// moved entry, or the same relative path inside it when `from` was a folder.
// null when the move didn't touch it.
export function movedPath(p, from, to) {
  if (p === from) return to;
  const prefix = from.endsWith(path.sep) ? from : from + path.sep;
  if (p.startsWith(prefix)) return to + path.sep + p.slice(prefix.length);
  return null;
}

// A note's body too big to keep, as a browser write's validator message.
export const BODY_LIMIT_MESSAGE = "Notes are limited to 256 KB";

export function createNotesStore(storage) {
  const NOTES = "notes";
  const SURFACES = "surfaces";
  // Browser code could write records directly (ctx.storage); hold those to
  // the same limit the routes do.
  storage.collection(NOTES).validate((_key, note) =>
    typeof note?.body === "string" && note.body.length > MAX_BODY ? BODY_LIMIT_MESSAGE : undefined,
  );

  const tx = (fn) => storage.transaction((t) => fn(t.collection(NOTES), t.collection(SURFACES)));

  return {
    async all() {
      const rows = await storage.collection(NOTES).list();
      return rows.map((r) => r.value).sort((a, b) => a.createdAt - b.createdAt);
    },

    async create(fields, now = Date.now()) {
      const note = { id: newNoteId(), ...fields, createdAt: now, updatedAt: now };
      await storage.collection(NOTES).put(note.id, note);
      return note;
    },

    // Only these fields change; anything else in `patch` is ignored. A
    // card's colour, box or hidden flag doesn't count as an edit, so it
    // leaves updatedAt alone.
    async patch(id, patch, now = Date.now()) {
      const result = await storage.collection(NOTES).update(id, (note) => {
        if (!note) return undefined;
        let edited = false;
        for (const key of ["body", "windowId", "windowLabel", "filePath"]) {
          if (key in patch) {
            note[key] = patch[key];
            edited = true;
          }
        }
        if ("color" in patch && COLORS.includes(patch.color)) note.color = patch.color;
        if ("layout" in patch) {
          const layout = cleanLayout(patch.layout);
          if (layout) note.layout = layout;
          else delete note.layout;
        }
        if ("hidden" in patch) {
          if (patch.hidden) note.hidden = true;
          else delete note.hidden;
        }
        if (edited) note.updatedAt = now;
        return note;
      });
      return result ? result.value : null;
    },

    async surfaces() {
      const rows = await storage.collection(SURFACES).list();
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },

    // Hides (or shows) every card on one terminal ("window:<id>") or file
    // preview ("file:<path>").
    async setSurfaceHidden(key, hidden) {
      if (hidden) await storage.collection(SURFACES).put(key, { hidden: true });
      else await storage.collection(SURFACES).delete(key);
    },

    // Shows again the cards hidden one by one among `ids`.
    unhide(ids) {
      return tx((notes) => {
        let count = 0;
        for (const id of ids) {
          const note = notes.get(id)?.value;
          if (!note?.hidden) continue;
          delete note.hidden;
          notes.put(id, note);
          count++;
        }
        return count;
      });
    },

    remove(id) {
      return tx((notes) => {
        const existed = Boolean(notes.get(id));
        notes.delete(id);
        return existed;
      });
    },

    // Carries file notes along after renames and moves made in Perch's FILES
    // panel. Returns how many notes moved.
    renameFiles(pairs, now = Date.now()) {
      return tx((notes) => {
        let count = 0;
        for (const { key, value: note } of notes.list()) {
          if (note.scope !== "file" || !note.filePath) continue;
          for (const { from, to } of pairs) {
            const next = movedPath(note.filePath, from, to);
            if (next === null) continue;
            note.filePath = next;
            note.updatedAt = now;
            notes.put(key, note);
            count++;
            break;
          }
        }
        return count;
      });
    },
  };
}
