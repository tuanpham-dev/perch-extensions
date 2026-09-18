// git-history server hook: one file's history, one file's blame, and the two
// sides of a file at any commit — all read-only. No route here writes to the
// repository, and none reaches a remote.
//
// The `run`/`git` helpers and the repo-root resolution reimplement what the
// github extension's server.js does (and what perch core does in
// server/src/git.ts): this registry repo can't import core or across
// extensions, so they're copied with this comment naming the source rather
// than silently duplicated.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GIT_TIMEOUT = 15000;
// A blame walks the whole history of one file, which on a long-lived file in
// a big repository legitimately outlasts the ordinary timeout.
const BLAME_TIMEOUT = 60000;
// Past this, blame's porcelain output is more than the browser should hold
// for a file nobody reads line-by-line anyway.
const MAX_BLAME_BYTES = 2 * 1024 * 1024;

function run(cmd, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        encoding: "utf8",
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        // Nothing here talks to a remote, but a repository with an
        // http.extraHeader or a submodule could still make git ask; it must
        // fail rather than hang a read-only request.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || stdout.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
}

const git = (args, cwd, timeout = GIT_TIMEOUT) => run("git", args, cwd, timeout);

// The repository containing `dir`, or null. --show-toplevel resolves to the
// worktree the path is in, which is the right root here: a file's history is
// read in whichever worktree the user is looking at.
async function repoRootOf(dir) {
  try {
    return (await git(["rev-parse", "--show-toplevel"], dir)).trim();
  } catch {
    return null;
  }
}

// Mirrors core's own containment check (server/src/git.ts): a path from the
// client is only ever used after it resolves back inside the repository.
function resolveSafePath(root, relPath) {
  const resolved = path.resolve(root, relPath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

const COMMIT_HASH_RE = /^[0-9a-f]{4,40}$/i;

// \x1f between fields, \x1e BEFORE each record — neither can appear in a
// hash, a name, a timestamp or a single-line subject, so no escaping is
// needed. The separator leads rather than trails because --name-status
// appends its lines after the formatted output: with a trailing separator
// each commit's file list would land at the head of the NEXT record.
const LOG_FORMAT = "%x1e%H%x1f%an%x1f%at%x1f%s";

// A NUL byte in the first few KB is what every diff tool treats as "binary".
function looksBinary(buf) {
  const end = Math.min(buf.length, 8192);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

export function activate({ router }) {
  // Resolve a request's repo root and the path relative to it. Every route
  // below starts here, so a path outside a repository (or outside its root)
  // is refused in one place.
  async function resolveTarget(req, res) {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!cwd && !filePath) {
      res.status(400).json({ error: "cwd or path is required" });
      return null;
    }
    const root = await repoRootOf(cwd || path.dirname(filePath));
    if (!root) {
      res.status(400).json({ error: "Not a git repository." });
      return null;
    }
    if (!filePath) return { root, relPath: "", abs: "" };
    const abs = path.isAbsolute(filePath) ? filePath : resolveSafePath(root, filePath);
    if (!abs || !resolveSafePath(root, path.relative(root, abs))) {
      res.status(400).json({ error: "path escapes the repository root" });
      return null;
    }
    return { root, relPath: path.relative(root, abs), abs };
  }

  // Is this path inside a repository? The FILES-tree menu asks once per
  // directory and caches the answer, because isVisible has to answer
  // synchronously.
  router.get("/repo", async (req, res) => {
    const target = typeof req.query.path === "string" ? req.query.path : "";
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    const root = await repoRootOf(cwd || target);
    res.json({ root });
  });

  // One file's commits, newest first, following it through renames. The
  // name-status line under each record carries the path AT that commit,
  // which is what a diff of that revision has to ask for.
  router.get("/history", async (req, res) => {
    const target = await resolveTarget(req, res);
    if (!target) return;
    if (!target.relPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : 50;
    const rawSkip = Number(req.query.skip);
    const skip = Number.isFinite(rawSkip) && rawSkip > 0 ? Math.floor(rawSkip) : 0;
    try {
      const raw = await git(
        [
          "log",
          "--follow",
          "--name-status",
          "-M",
          `--format=${LOG_FORMAT}`,
          "-n",
          String(limit),
          "--skip",
          String(skip),
          "--",
          target.relPath,
        ],
        target.root,
      );
      const commits = raw
        .split("\x1e")
        // The leading separator makes the first chunk empty.
        .filter((record) => record.trim().length > 0)
        .map((record) => {
          const [hash, author, timestamp, rest] = record.split("\x1f");
          // `rest` is the subject followed by this commit's name-status
          // lines: "<subject>\n\nM\tpath" (or "R100\told\tnew").
          const lines = (rest ?? "").split("\n");
          const subject = lines[0] ?? "";
          const statusLine = lines.slice(1).find((l) => l.trim().length > 0) ?? "";
          const fields = statusLine.split("\t");
          const code = fields[0] ?? "";
          const isRename = code.startsWith("R") || code.startsWith("C");
          return {
            hash,
            author,
            timestamp: Number(timestamp),
            subject,
            status: code ? code[0] : "M",
            // The path this commit knew the file by, and for a rename the
            // name it had before.
            path: (isRename ? fields[2] : fields[1]) ?? target.relPath,
            oldPath: isRename ? (fields[1] ?? null) : null,
          };
        });
      res.json({ commits, path: target.relPath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Blame's porcelain form, parsed on the client (blameModel.ts) so the
  // parser can be unit-tested without a repository.
  router.get("/blame", async (req, res) => {
    const target = await resolveTarget(req, res);
    if (!target) return;
    if (!target.relPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const rev = typeof req.query.rev === "string" ? req.query.rev.trim() : "";
    if (rev && !COMMIT_HASH_RE.test(rev)) {
      res.status(400).json({ error: "rev must be a hex commit SHA" });
      return;
    }
    try {
      // Size and binary are checked against the revision actually being
      // blamed: the working file may not even exist at an older rev.
      const content = rev
        ? Buffer.from(await git(["show", `${rev}:${target.relPath}`], target.root), "utf8")
        : fs.existsSync(target.abs)
          ? fs.readFileSync(target.abs)
          : Buffer.alloc(0);
      if (content.length > MAX_BLAME_BYTES) {
        res.json({ tooLarge: true, porcelain: "" });
        return;
      }
      if (looksBinary(content)) {
        res.json({ binary: true, porcelain: "" });
        return;
      }
      const args = ["blame", "--porcelain"];
      if (rev) args.push(rev);
      args.push("--", target.relPath);
      const porcelain = await git(args, target.root, BLAME_TIMEOUT);
      res.json({ porcelain, rev: rev || null, path: target.relPath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // One file's patch at one commit, for the History tab's own diff pane.
  // The content-pair route below still exists for handing a diff to the
  // configured editor; this one is what the tab renders inline.
  router.get("/file-diff", async (req, res) => {
    const target = await resolveTarget(req, res);
    if (!target) return;
    if (!target.relPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const hash = typeof req.query.hash === "string" ? req.query.hash : "";
    if (!COMMIT_HASH_RE.test(hash)) {
      res.status(400).json({ error: "hash must be a hex commit SHA" });
      return;
    }
    const oldPath = typeof req.query.oldPath === "string" && req.query.oldPath ? req.query.oldPath : "";
    if (oldPath && !resolveSafePath(target.root, oldPath)) {
      res.status(400).json({ error: "oldPath escapes the repository root" });
      return;
    }
    try {
      // Both pathspecs for a rename, or git renders it as a plain "new
      // file" instead of a rename with its content change.
      const paths = oldPath && oldPath !== target.relPath ? [oldPath, target.relPath] : [target.relPath];
      const diff = await git(["show", hash, "-m", "--first-parent", "--format=", "--patch", "--", ...paths], target.root);
      res.json({ diff });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The two sides of one file at one commit, as content — the shape the
  // host's editor-neutral openDiff takes, so this extension needs no diff
  // viewer of its own.
  router.get("/diff-sides", async (req, res) => {
    const target = await resolveTarget(req, res);
    if (!target) return;
    const hash = typeof req.query.hash === "string" ? req.query.hash : "";
    if (!COMMIT_HASH_RE.test(hash)) {
      res.status(400).json({ error: "hash must be a hex commit SHA" });
      return;
    }
    const oldPath = typeof req.query.oldPath === "string" && req.query.oldPath ? req.query.oldPath : target.relPath;
    if (!resolveSafePath(target.root, oldPath)) {
      res.status(400).json({ error: "oldPath escapes the repository root" });
      return;
    }
    // git show exits non-zero when the path isn't in that tree — an added
    // file has no parent blob, a deleted one has no commit blob. Both are an
    // empty side, not an error.
    const showOrEmpty = async (rev) => {
      try {
        return { content: await git(["show", rev], target.root), missing: false };
      } catch {
        return { content: "", missing: true };
      }
    };
    try {
      const short = hash.slice(0, 7);
      const before = await showOrEmpty(`${hash}^:${oldPath}`);
      const after = await showOrEmpty(`${hash}:${target.relPath}`);
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
}
