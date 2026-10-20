// Agent Sessions server hook: past agent conversations for a project, read
// through core's session readers (host.agentSessions), and resuming one in a
// new terminal window.
//
//   GET  /sessions?cwd=            the project's conversations, across its
//                                  worktrees, newest first
//   GET  /messages?agent=&id=&cwd= the last 50 messages of one
//   POST /resume                   { agentId, id, cwd, title } -> the window
//                                  it opened, or the one it's already open in
//
// Read-only toward the agents: nothing here writes to a transcript.
import os from "node:os";
import path from "node:path";

const PREVIEW_MESSAGES = 50;

function expandHome(p) {
  if (typeof p !== "string") return "";
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const same = (a, b) => path.resolve(expandHome(a)) === path.resolve(expandHome(b));

export function activate({ router, host, log }) {
  // The folders whose conversations belong to this project: every worktree
  // of its repository (each tagged with its branch), or just the folder.
  async function foldersOf(cwd) {
    try {
      const listing = await host.worktrees.list(cwd);
      if (listing.repo && listing.worktrees.length > 0) {
        return listing.worktrees.map((w) => ({ path: w.path, branch: w.branch ?? null }));
      }
    } catch {
      // not a repository, or git isn't there
    }
    return [{ path: path.resolve(expandHome(cwd)), branch: null }];
  }

  router.get("/sessions", async (req, res) => {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    if (!cwd) {
      res.status(400).json({ error: "cwd is required" });
      return;
    }
    try {
      const folders = await foldersOf(cwd);
      const perFolder = await Promise.all(
        folders.map(async (f) => (await host.agentSessions.list(f.path)).map((s) => ({ ...s, branch: f.branch }))),
      );
      const agents = (await host.agents.list()).map((a) => a.label);
      const sessions = perFolder.flat().sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      res.json({ sessions, agents });
    } catch (err) {
      log?.("listing failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/messages", async (req, res) => {
    const { agent, id, cwd } = req.query;
    if (typeof agent !== "string" || typeof id !== "string" || typeof cwd !== "string") {
      res.status(400).json({ error: "agent, id and cwd are required" });
      return;
    }
    try {
      res.json({ messages: await host.agentSessions.messages(agent, id, cwd, PREVIEW_MESSAGES) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/resume", async (req, res) => {
    const { agentId, id, cwd, title } = req.body ?? {};
    if (typeof agentId !== "string" || typeof id !== "string" || typeof cwd !== "string") {
      res.status(400).json({ error: "agentId, id and cwd are required" });
      return;
    }
    try {
      // Already open somewhere: that window, not a second copy of the agent
      // on the same conversation.
      const listed = await host.agentSessions.list(cwd);
      const open = listed.find((s) => s.agentId === agentId && s.id === id)?.openIn;
      if (open) {
        res.json({ sessionName: open.sessionName, windowIndex: open.windowIndex, alreadyOpen: true });
        return;
      }
      const command = await host.agentSessions.resumeCommand(agentId, id);
      if (!command) {
        res.status(400).json({ error: "This agent can't reopen a chosen conversation" });
        return;
      }
      const sessions = await host.sessions.list();
      let session = sessions.find((s) => !s.name.startsWith("perch-view-") && same(s.path, cwd));
      if (!session) session = await host.sessions.create(undefined, cwd, true);
      const name = typeof title === "string" && title.trim() ? title.trim().slice(0, 40) : "resumed";
      // Declared on the window, so a restart reopens the same conversation.
      const windowIndex = await host.sessions.createWindow(session.name, cwd, name, command);
      res.json({ sessionName: session.name, windowIndex, alreadyOpen: false });
    } catch (err) {
      log?.("resume failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
