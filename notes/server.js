// Notes server hook: private Markdown notes on a project, a terminal window or
// a file, kept in the host's extension storage (see store.mjs) - on this
// server, never in a repository, so every browser and device sees the same
// notes. Needs Perch 0.9 or newer for that storage.
//
//   GET    /notes?session=&window=    the session's project notes, the
//                                     window's, its files', and the detached
//   POST   /notes                     { session, window?, scope, filePath?, body }
//   PUT    /notes/:id                 { body? } | { reattachWindow } | { reattachFile }
//   DELETE /notes/:id
//   POST   /notes/rename              { pairs: [{ from, to }] } after a FILES rename
//   GET    /marks                     the windows ({ sessionName, windowIndex })
//                                     and files that have notes, with counts,
//                                     for the badges in PROJECTS and FILES
//   GET    /float?session=&window=     what floats over a terminal: its notes
//                                     and its project's, and whether that
//                                     terminal's cards are hidden; the
//                                     project's file notes float there too
//                                     (and are also listed as `files`)
//   GET    /float?file=                what floats over a file's previews
//   PUT    /surface                   { kind: "window" | "file", key, hidden }
//   POST   /show-all                  { ids } unhides those notes' cards
//
// PUT /notes/:id also takes { color, layout: { x, y, w, h }, hidden }.
//
// A window note is keyed by the window's stable id; a window that no longer
// exists in any session leaves its notes "detached" under the project, as
// does a file note whose file is gone.
import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { BODY_LIMIT_MESSAGE, COLORS, MAX_BODY, SCOPES, cleanLayout, createNotesStore } from "./store.mjs";

function expandHome(p) {
  if (typeof p !== "string") return "";
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function bodyOf(value) {
  if (typeof value !== "string") return null;
  return value.length > MAX_BODY ? null : value;
}

// A file note with `relPath`: its file's path inside the project, for the
// card's header (the absolute path when the file is outside the project).
function withRelPath(note, projectRoot) {
  const rel = path.relative(projectRoot, note.filePath);
  return { ...note, relPath: rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : note.filePath };
}

export function activate({ router, host, log, storage }) {
  // A Perch older than 0.9 has no extension storage: serve nothing, and the
  // NOTES pane says which Perch it needs.
  if (!storage) {
    log("Notes needs Perch 0.9 or newer (no extension storage)");
    return;
  }
  const store = createNotesStore(storage);

  async function sessions() {
    return (await host.sessions.list()).filter((s) => !s.name.startsWith("perch-view-"));
  }

  // The session, its project folder, and (with an index) the window.
  async function locate(sessionName, windowIndex) {
    const list = await sessions();
    const session = list.find((s) => s.name === sessionName);
    if (!session) return null;
    const window = Number.isInteger(windowIndex) ? session.windows.find((w) => w.index === windowIndex) : undefined;
    return { session, list, projectPath: session.path, window };
  }

  const windowLabel = (session, window) => `${path.basename(expandHome(session.path)) || session.name} · ${window.name}`;

  router.get("/notes", async (req, res) => {
    try {
      const windowIndex = req.query.window === undefined || req.query.window === "" ? null : Number(req.query.window);
      const where = await locate(String(req.query.session ?? ""), windowIndex);
      if (!where) {
        res.json({ projectPath: null, notes: [] });
        return;
      }
      const liveWindows = new Map();
      for (const s of where.list) for (const w of s.windows) liveWindows.set(w.id, { session: s, window: w });
      const notes = (await store.all()).filter((n) => n.projectPath === where.projectPath);
      const out = await Promise.all(
        notes.map(async (n) => {
          let detached = false;
          if (n.scope === "window") detached = !liveWindows.has(n.windowId);
          else if (n.scope === "file") detached = !(await exists(n.filePath));
          const live = n.scope === "window" ? liveWindows.get(n.windowId) : undefined;
          return {
            ...n,
            detached,
            // A live window's current name, so a renamed window reads right.
            windowLabel: live ? windowLabel(live.session, live.window) : n.windowLabel,
          };
        }),
      );
      res.json({
        projectPath: where.projectPath,
        // Absolute, for showing file notes relative to it.
        projectRoot: path.resolve(expandHome(where.projectPath)),
        windowId: where.window?.id ?? null,
        windowLabel: where.window ? windowLabel(where.session, where.window) : null,
        notes: out,
      });
    } catch (err) {
      log?.("notes list failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/notes", async (req, res) => {
    const { session: sessionName, window: windowIndex, scope, filePath } = req.body ?? {};
    const body = bodyOf(req.body?.body ?? "");
    if (!SCOPES.includes(scope) || body === null) {
      res.status(400).json({ error: "scope must be project, window or file, and body a string under 256KB" });
      return;
    }
    try {
      let where = await locate(String(sessionName ?? ""), Number.isInteger(windowIndex) ? windowIndex : null);
      // A file note made from a preview: its project is the open session
      // whose folder holds the file most closely.
      if (!where && scope === "file" && typeof filePath === "string") {
        const abs = path.resolve(expandHome(filePath));
        const list = await sessions();
        const owner = list
          .filter((x) => abs.startsWith(path.resolve(expandHome(x.path)) + path.sep))
          .sort((a, b) => expandHome(b.path).length - expandHome(a.path).length)[0];
        if (owner) where = { session: owner, list, projectPath: owner.path, window: undefined };
      }
      if (!where) {
        res.status(404).json({ error: sessionName ? `No session named ${sessionName}` : "Open the file's project first" });
        return;
      }
      const fields = { scope, projectPath: where.projectPath, body };
      if (COLORS.includes(req.body?.color)) fields.color = req.body.color;
      const layout = cleanLayout(req.body?.layout);
      if (layout) fields.layout = layout;
      if (scope === "window") {
        if (!where.window) {
          res.status(400).json({ error: "A terminal note needs an open window" });
          return;
        }
        fields.windowId = where.window.id;
        fields.windowLabel = windowLabel(where.session, where.window);
      }
      if (scope === "file") {
        const abs = path.resolve(expandHome(String(filePath ?? "")));
        if (!filePath || !(await exists(abs))) {
          res.status(400).json({ error: `No file at ${filePath}` });
          return;
        }
        fields.filePath = abs;
      }
      res.status(201).json(await store.create(fields));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/notes/:id", async (req, res) => {
    const patch = {};
    try {
      if ("body" in (req.body ?? {})) {
        const body = bodyOf(req.body.body);
        if (body === null) {
          res.status(400).json({ error: typeof req.body.body === "string" ? BODY_LIMIT_MESSAGE : "body must be a string" });
          return;
        }
        patch.body = body;
      }
      if (req.body?.reattachWindow) {
        const { session: sessionName, window: windowIndex } = req.body.reattachWindow;
        const where = await locate(String(sessionName ?? ""), Number(windowIndex));
        if (!where?.window) {
          res.status(400).json({ error: "That terminal isn't open" });
          return;
        }
        patch.windowId = where.window.id;
        patch.windowLabel = windowLabel(where.session, where.window);
      }
      if (req.body?.reattachFile) {
        const abs = path.resolve(expandHome(String(req.body.reattachFile)));
        if (!(await exists(abs))) {
          res.status(400).json({ error: `No file at ${req.body.reattachFile}` });
          return;
        }
        patch.filePath = abs;
      }
      if ("color" in (req.body ?? {})) {
        if (!COLORS.includes(req.body.color)) {
          res.status(400).json({ error: `color must be one of ${COLORS.join(", ")}` });
          return;
        }
        patch.color = req.body.color;
      }
      if ("layout" in (req.body ?? {})) patch.layout = req.body.layout === null ? null : cleanLayout(req.body.layout);
      if ("hidden" in (req.body ?? {})) patch.hidden = req.body.hidden === true;
      const note = await store.patch(req.params.id, patch);
      if (!note) {
        res.status(404).json({ error: "No such note" });
        return;
      }
      res.json(note);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/notes/:id", async (req, res) => {
    try {
      res.status((await store.remove(req.params.id)) ? 204 : 404).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/notes/rename", async (req, res) => {
    const pairs = Array.isArray(req.body?.pairs) ? req.body.pairs : [];
    const clean = pairs
      .filter((p) => typeof p?.from === "string" && typeof p?.to === "string" && p.from && p.to)
      .map((p) => ({ from: path.resolve(expandHome(p.from)), to: path.resolve(expandHome(p.to)) }));
    try {
      res.json({ moved: clean.length ? await store.renameFiles(clean) : 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // What floats over one terminal (session + window) or one file.
  router.get("/float", async (req, res) => {
    try {
      const notes = await store.all();
      const surfaces = await store.surfaces();
      if (typeof req.query.file === "string" && req.query.file) {
        const file = path.resolve(expandHome(req.query.file));
        const key = `file:${file}`;
        res.json({
          key,
          hiddenAll: Boolean(surfaces[key]?.hidden),
          notes: notes
            .filter((n) => n.scope === "file" && n.filePath === file)
            .map((n) => withRelPath(n, path.resolve(expandHome(n.projectPath)))),
        });
        return;
      }
      const windowIndex = Number(req.query.window);
      const where = await locate(String(req.query.session ?? ""), Number.isInteger(windowIndex) ? windowIndex : null);
      if (!where?.window) {
        res.json({ key: null, hiddenAll: false, notes: [] });
        return;
      }
      const key = `window:${where.window.id}`;
      const projectRoot = path.resolve(expandHome(where.projectPath));
      // The project's file notes float over every terminal of the project,
      // as project notes do: only files that are still there (a missing
      // one's note is detached). Each carries its path in the project.
      const projectFiles = notes.filter((n) => n.scope === "file" && n.projectPath === where.projectPath);
      const present = await Promise.all(projectFiles.map((n) => exists(n.filePath)));
      const files = projectFiles.filter((_n, i) => present[i]).map((n) => withRelPath(n, projectRoot));
      res.json({
        key,
        windowId: where.window.id,
        windowLabel: windowLabel(where.session, where.window),
        projectPath: where.projectPath,
        projectRoot,
        hiddenAll: Boolean(surfaces[key]?.hidden),
        notes: [
          ...notes.filter(
            (n) =>
              (n.scope === "window" && n.windowId === where.window.id) ||
              (n.scope === "project" && n.projectPath === where.projectPath),
          ),
          ...files,
        ],
        files,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/surface", async (req, res) => {
    const key = String(req.body?.key ?? "");
    if (!/^(window|file):.+/.test(key)) {
      res.status(400).json({ error: "key must be window:<id> or file:<path>" });
      return;
    }
    try {
      await store.setSurfaceHidden(key, req.body?.hidden === true);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/show-all", async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === "string") : [];
    try {
      res.json({ shown: await store.unhide(ids) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/marks", async (_req, res) => {
    try {
      const notes = await store.all();
      const byWindow = new Map();
      const files = {};
      for (const n of notes) {
        if (n.scope === "window") byWindow.set(n.windowId, (byWindow.get(n.windowId) ?? 0) + 1);
        if (n.scope === "file") files[n.filePath] = (files[n.filePath] ?? 0) + 1;
      }
      const windows = [];
      for (const s of await sessions()) {
        for (const w of s.windows) {
          const count = byWindow.get(w.id);
          if (count) windows.push({ sessionName: s.name, windowIndex: w.index, count });
        }
      }
      res.json({ windows, files });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
