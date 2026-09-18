// git-graph server hook: the commit DAG for one repository, one commit's
// files and their two sides, and the ref/commit operations the graph's menus
// run.
//
// The `run`/`git` helpers, the repo-root resolution, the safe-path check and
// the ref-name validation reimplement what perch's bundled git-scm extension
// does (extensions/git-scm/server.js) and what core does in
// server/src/git.ts: this registry repo can't import core or across
// extensions, so they're copied with this comment naming the source rather
// than silently duplicated.
//
// Nothing here prompts for credentials. The one route that reaches a remote
// (deleting a remote branch) runs with GIT_TERMINAL_PROMPT=0, so on a remote
// that needs interactive auth it fails with git's own message instead of
// hanging - the README says so, and git-scm's BRANCHES pane is where that
// operation has a credential relay behind it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const GIT_TIMEOUT = 15000;
// A --all log on a large repository is the one read here that can be slow.
const LOG_TIMEOUT = 60000;
// And a push to delete a remote branch is a network call.
const REMOTE_TIMEOUT = 60000;

function run(cmd, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        encoding: "utf8",
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        // A conflicted cherry-pick, revert or merge writes its account to
        // stdout and exits non-zero with an empty stderr; without the stdout
        // fallback the client would show execFile's own "Command failed".
        if (err) reject(new Error(stderr.trim() || stdout.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
}

const git = (args, cwd, timeout = GIT_TIMEOUT) => run("git", args, cwd, timeout);

async function repoRootOf(dir) {
  if (!dir) return null;
  try {
    return (await git(["rev-parse", "--show-toplevel"], dir)).trim();
  } catch {
    return null;
  }
}

function resolveSafePath(root, relPath) {
  const resolved = path.resolve(root, relPath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

const COMMIT_HASH_RE = /^[0-9a-f]{4,40}$/i;
// A ref name passed as a positional argument must not start with "-", or git
// parses it as an option.
const SAFE_REF_RE = /^[^-]/;

// \x1f between fields, \x1e before each record.
const LOG_FORMAT = "%x1e%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s";

// diff-tree -z's numstat: "<added>\t<removed>\t<path>" per entry, with two
// extra NUL-separated fields instead of the path for a rename, and "-" for
// both counts on a binary file.
function parseNumstatZ(raw) {
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  const out = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const parts = tokens[i].split("\t");
    if (parts.length < 3) continue;
    const [added, removed] = parts;
    let oldPath = null;
    let filePath = parts.slice(2).join("\t");
    if (filePath === "") {
      oldPath = tokens[++i] ?? null;
      filePath = tokens[++i] ?? "";
    }
    if (!filePath) continue;
    const binary = added === "-" || removed === "-";
    out.set(filePath, { oldPath, added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), binary });
  }
  return out;
}

function parseNameStatusZ(raw) {
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  const out = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    const letter = code[0];
    let oldPath = null;
    let filePath;
    if (letter === "R" || letter === "C") {
      oldPath = tokens[++i] ?? null;
      filePath = tokens[++i] ?? "";
    } else {
      filePath = tokens[++i] ?? "";
    }
    if (!filePath) continue;
    out.set(filePath, { status: letter ?? "M", oldPath });
  }
  return out;
}

export function activate({ router }) {
  async function requireRoot(req, res) {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : (req.body?.cwd ?? "");
    const root = await repoRootOf(cwd);
    if (!root) {
      res.status(400).json({ error: "Not a git repository." });
      return null;
    }
    return root;
  }

  async function validRefName(name, cwd, kind = "branch") {
    if (typeof name !== "string") return null;
    const trimmed = name.trim();
    if (!trimmed || !SAFE_REF_RE.test(trimmed)) return null;
    const args =
      kind === "tag" ? ["check-ref-format", `refs/tags/${trimmed}`] : ["check-ref-format", "--branch", trimmed];
    try {
      await git(args, cwd);
      return trimmed;
    } catch {
      return null;
    }
  }

  // An operation that stops on a conflict leaves the repository mid-merge.
  // That isn't a failure to report as one: the reply says so, and the client
  // points at SOURCE CONTROL, which owns conflict resolution.
  async function inProgressOperation(root) {
    let gitDir;
    try {
      gitDir = (await git(["rev-parse", "--git-dir"], root)).trim();
    } catch {
      return null;
    }
    const abs = path.isAbsolute(gitDir) ? gitDir : path.join(root, gitDir);
    const fs = await import("node:fs");
    if (fs.existsSync(path.join(abs, "MERGE_HEAD"))) return "merge";
    if (fs.existsSync(path.join(abs, "CHERRY_PICK_HEAD"))) return "cherry-pick";
    if (fs.existsSync(path.join(abs, "REVERT_HEAD"))) return "revert";
    if (fs.existsSync(path.join(abs, "rebase-merge")) || fs.existsSync(path.join(abs, "rebase-apply"))) return "rebase";
    return null;
  }

  router.get("/repo", async (req, res) => {
    const root = await repoRootOf(typeof req.query.cwd === "string" ? req.query.cwd : "");
    res.json({ root });
  });

  // The DAG. --topo-order keeps a branch's commits together instead of
  // interleaving them by date, which is what makes the lanes readable.
  router.get("/log", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(2000, Math.floor(rawLimit)) : 300;
    const rawSkip = Number(req.query.skip);
    const skip = Number.isFinite(rawSkip) && rawSkip > 0 ? Math.floor(rawSkip) : 0;
    const withRemotes = req.query.remotes !== "0";
    try {
      const remoteNames = (await git(["remote"], root)).split("\n").map((r) => r.trim()).filter(Boolean);
      const scope = withRemotes
        ? ["--all"]
        : ["--branches", "--tags", "--glob=refs/stash", "HEAD"];
      const raw = await git(
        ["log", "--topo-order", `--format=${LOG_FORMAT}`, "-n", String(limit), "--skip", String(skip), ...scope],
        root,
        LOG_TIMEOUT,
      );
      const commits = raw
        .split("\x1e")
        .filter((record) => record.trim().length > 0)
        .map((record) => {
          const [hash, parents, author, timestamp, decorations, subject] = record.replace(/\n$/, "").split("\x1f");
          return {
            hash,
            parents: (parents ?? "").trim().split(/\s+/).filter(Boolean),
            author,
            timestamp: Number(timestamp),
            subject: subject ?? "",
            refs: parseDecorations(decorations ?? "", remoteNames),
          };
        });
      let total = commits.length;
      try {
        const counted = await git(["rev-list", "--count", ...scope], root, LOG_TIMEOUT);
        // With several scopes rev-list prints one count per line; the graph
        // only needs a ceiling for its "N of M" readout.
        total = counted
          .split("\n")
          .map((n) => Number(n.trim()))
          .filter((n) => Number.isFinite(n))
          .reduce((a, b) => a + b, 0);
      } catch {
        // An unborn branch has nothing to count.
      }
      res.json({ root, commits, total, refsHash: await refsDigest(root) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // "HEAD -> main, origin/main, tag: v1.0, refs/stash". A ref name can't
  // contain a space, so splitting on ", " is safe.
  function parseDecorations(decorations, remoteNames) {
    return decorations
      .split(", ")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        if (item.startsWith("HEAD -> ")) return { name: item.slice("HEAD -> ".length), type: "branch", current: true };
        if (item === "HEAD") return { name: "HEAD", type: "head", current: true };
        if (item.startsWith("tag: ")) return { name: item.slice("tag: ".length), type: "tag", current: false };
        if (item === "refs/stash") return { name: "stash", type: "stash", current: false };
        const remote = remoteNames.find((r) => item.startsWith(`${r}/`));
        if (remote) return { name: item, type: "remote", current: false, remote, branch: item.slice(remote.length + 1) };
        return { name: item, type: "branch", current: false };
      });
  }

  // A cheap digest of every ref plus HEAD. /log returns it too, so the tab
  // always knows which ref state the rows it is showing were read at - even
  // across a remount - and a poll tick can tell "unchanged" from "never
  // looked".
  async function refsDigest(root) {
    const refs = await git(["for-each-ref", "--format=%(objectname)%(refname)"], root);
    let head = "";
    try {
      head = (await git(["rev-parse", "HEAD"], root)).trim();
    } catch {
      // Unborn branch.
    }
    // HEAD's own name, not just what it resolves to: detaching HEAD, or
    // switching between two branches that point at the same commit, moves
    // no object id at all, and the graph's labels would otherwise go stale
    // with nothing to notice.
    let headName = "";
    try {
      headName = (await git(["symbolic-ref", "-q", "HEAD"], root)).trim();
    } catch {
      // Detached: no symbolic ref, which is itself the distinguishing fact.
    }
    return createHash("sha1").update(`${refs}\n${head}\n${headName}`).digest("hex");
  }

  router.get("/refs-hash", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    try {
      res.json({ hash: await refsDigest(root) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/commit-files", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    const hash = typeof req.query.hash === "string" ? req.query.hash : "";
    if (!COMMIT_HASH_RE.test(hash)) {
      res.status(400).json({ error: "hash must be a hex commit SHA" });
      return;
    }
    try {
      const parents = (await git(["rev-list", "--parents", "-n", "1", hash], root)).trim().split(/\s+/).slice(1);
      // A merge has no single diff against all its parents, so its file list
      // is read against the first parent - what the merge brought in.
      const range = parents.length > 0 ? [`${hash}^1`, hash] : ["--root", hash];
      const base = ["diff-tree", "-r", "-M", "--no-commit-id", "-z", ...range];
      const [rawNumstat, rawNameStatus] = await Promise.all([
        git([...base, "--numstat"], root),
        git([...base, "--name-status"], root),
      ]);
      const stats = parseNumstatZ(rawNumstat);
      const statuses = parseNameStatusZ(rawNameStatus);
      const files = [...statuses.entries()]
        .map(([filePath, entry]) => {
          const stat = stats.get(filePath);
          return {
            path: filePath,
            oldPath: entry.oldPath ?? stat?.oldPath ?? null,
            status: entry.status,
            added: stat?.added ?? 0,
            removed: stat?.removed ?? 0,
            binary: stat?.binary ?? false,
          };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
      res.json({ files, merge: parents.length > 1 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Both sides of one file at one commit, as content - the shape the host's
  // editor-neutral openDiff takes.
  router.get("/diff-sides", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    const hash = typeof req.query.hash === "string" ? req.query.hash : "";
    const relPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!COMMIT_HASH_RE.test(hash)) {
      res.status(400).json({ error: "hash must be a hex commit SHA" });
      return;
    }
    if (!relPath || !resolveSafePath(root, relPath)) {
      res.status(400).json({ error: "path is required and must stay inside the repository" });
      return;
    }
    const oldPath = typeof req.query.oldPath === "string" && req.query.oldPath ? req.query.oldPath : relPath;
    if (!resolveSafePath(root, oldPath)) {
      res.status(400).json({ error: "oldPath escapes the repository root" });
      return;
    }
    const showOrEmpty = async (rev) => {
      try {
        return { content: await git(["show", rev], root), missing: false };
      } catch {
        return { content: "", missing: true };
      }
    };
    try {
      const short = hash.slice(0, 7);
      const before = await showOrEmpty(`${hash}^:${oldPath}`);
      const after = await showOrEmpty(`${hash}:${relPath}`);
      res.json({
        original: { content: before.content, label: before.missing ? `${short}^ (new file)` : `${short}^` },
        modified: {
          content: after.content,
          label: after.missing ? `${short} (deleted)` : short,
          readOnlyReason: "This is a committed revision.",
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Operations ----

  // Every mutating route ends here: run the args, and report a conflict stop
  // as an outcome rather than an error.
  async function runOp(root, args, res, timeout = GIT_TIMEOUT) {
    try {
      await git(args, root, timeout);
      res.json({ ok: true });
    } catch (err) {
      const operation = await inProgressOperation(root);
      if (operation) {
        res.json({ ok: true, conflicted: true, operation });
        return;
      }
      res.status(500).json({ error: err.message });
    }
  }

  function hashOf(req, res) {
    const hash = typeof req.body?.hash === "string" ? req.body.hash.trim() : "";
    if (!COMMIT_HASH_RE.test(hash)) {
      res.status(400).json({ error: "hash must be a hex commit SHA" });
      return null;
    }
    return hash;
  }

  router.post("/checkout", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    const detach = typeof req.body?.hash === "string" ? req.body.hash.trim() : "";
    const track = typeof req.body?.track === "string" ? req.body.track.trim() : "";
    if (detach) {
      if (!COMMIT_HASH_RE.test(detach)) {
        res.status(400).json({ error: "hash must be a hex commit SHA" });
        return;
      }
      await runOp(root, ["switch", "--detach", detach], res);
      return;
    }
    const branch = await validRefName(req.body?.branch, root, "branch");
    if (!branch) {
      res.status(400).json({ error: "branch is required and must be a valid branch name" });
      return;
    }
    if (track) {
      if (!track.includes("/") || !SAFE_REF_RE.test(track)) {
        res.status(400).json({ error: "track must be a <remote>/<branch> ref" });
        return;
      }
      // Only start tracking when the local name isn't taken; otherwise this
      // is an ordinary switch.
      let exists = true;
      try {
        await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root);
      } catch {
        exists = false;
      }
      await runOp(root, exists ? ["switch", branch] : ["switch", "--track", track], res);
      return;
    }
    await runOp(root, ["switch", branch], res);
  });

  router.post("/branch-create", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    const name = await validRefName(req.body?.name, root, "branch");
    const hash = hashOf(req, res);
    if (!hash) return;
    if (!name) {
      res.status(400).json({ error: "name is required and must be a valid branch name" });
      return;
    }
    const checkout = req.body?.checkout === true;
    try {
      await git(["branch", name, hash], root);
      if (checkout) await git(["switch", name], root);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/tag-create", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    const name = await validRefName(req.body?.name, root, "tag");
    const hash = hashOf(req, res);
    if (!hash) return;
    if (!name) {
      res.status(400).json({ error: "name is required and must be a valid tag name" });
      return;
    }
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const args = ["tag"];
    if (message) args.push("-a", "-m", message);
    args.push(name, hash);
    await runOp(root, args, res);
  });

  router.post("/cherry-pick", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    const hash = hashOf(req, res);
    if (!hash) return;
    await runOp(root, ["cherry-pick", hash], res);
  });

  router.post("/revert", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    const hash = hashOf(req, res);
    if (!hash) return;
    await runOp(root, ["revert", "--no-edit", hash], res);
  });

  const RESET_MODES = new Set(["soft", "mixed", "hard"]);

  router.post("/reset", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    const hash = hashOf(req, res);
    if (!hash) return;
    const mode = typeof req.body?.mode === "string" ? req.body.mode : "";
    if (!RESET_MODES.has(mode)) {
      res.status(400).json({ error: "mode must be soft, mixed or hard" });
      return;
    }
    await runOp(root, ["reset", `--${mode}`, hash], res);
  });

  router.post("/branch-delete", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    const name = await validRefName(req.body?.name, root, "branch");
    if (!name) {
      res.status(400).json({ error: "name is required and must be a valid branch name" });
      return;
    }
    const force = req.body?.force === true;
    try {
      await git(["branch", force ? "-D" : "-d", name], root);
      res.json({ ok: true });
    } catch (err) {
      const message = (err.message || "").toString();
      // git refuses a branch whose work isn't merged anywhere; the client
      // offers to force only after showing that refusal.
      if (!force && /not fully merged/i.test(message)) {
        res.status(409).json({ error: message.trim(), unmerged: true });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  router.post("/tag-delete", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    const name = await validRefName(req.body?.name, root, "tag");
    if (!name) {
      res.status(400).json({ error: "name is required and must be a valid tag name" });
      return;
    }
    await runOp(root, ["tag", "-d", name], res);
  });

  // The one route that reaches the network. See this file's header on why it
  // can't prompt for credentials.
  router.post("/remote-branch-delete", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    const remote = typeof req.body?.remote === "string" ? req.body.remote.trim() : "";
    const name = await validRefName(req.body?.branch, root, "branch");
    if (!remote || !SAFE_REF_RE.test(remote)) {
      res.status(400).json({ error: "remote is required" });
      return;
    }
    if (!name) {
      res.status(400).json({ error: "branch is required and must be a valid branch name" });
      return;
    }
    try {
      await git(["push", remote, "--delete", name], root, REMOTE_TIMEOUT);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
