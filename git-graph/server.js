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
// The pseudo-hash of the graph's Uncommitted Changes row. Not hex, so it can
// never be mistaken for (or collide with) a real commit.
const WORKING = "WORKING";
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

// A query value the client sent as a list: either repeated parameters or one
// \x1f-joined string, the same separator the log records use.
function toList(value) {
  if (Array.isArray(value)) return value.flatMap((v) => toList(v));
  if (typeof value !== "string") return [];
  return value
    .split("\x1f")
    .map((item) => item.trim())
    .filter(Boolean);
}

// A ref the branch filter named. It is passed to `git log` as a positional
// argument, so it must not start with "-" (git would read it as an option)
// and must not carry whitespace or control characters. Everything the filter
// offers comes from this extension's own /refs listing; this is the guard for
// a hand-edited request.
const REF_ARG_RE = /^[^-\s\x00-\x1f][^\s\x00-\x1f]*$/;

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

  // Which commits the graph walks: the refs the branch filter names, or -
  // when it names none - every ref of the kinds its toggles leave on.
  // Explicit flags rather than --all so one toggle can drop one kind of ref
  // without taking the others with it.
  function logScope(query) {
    const refs = toList(query.refs).filter((ref) => REF_ARG_RE.test(ref));
    if (refs.length > 0) return refs.slice(0, 200);
    const scope = ["--branches"];
    if (query.remotes !== "0") scope.push("--remotes");
    if (query.tags !== "0") scope.push("--tags");
    if (query.stashes !== "0") scope.push("--glob=refs/stash");
    // HEAD last so a detached HEAD is still walked when no branch points at
    // it, without displacing the refs above.
    scope.push("HEAD");
    return scope;
  }

  // The narrowing that applies to whichever scope came back above. --author
  // patterns are fixed strings so a name with a "." or "+" in it matches
  // itself; several are OR-ed by git, which is what the author filter's
  // multi-select means.
  function logFilters(query) {
    const args = [];
    const authors = toList(query.authors).slice(0, 50);
    for (const author of authors) args.push(`--author=${author}`);
    if (authors.length > 0) args.push("--fixed-strings", "--regexp-ignore-case");
    if (query.firstParent === "1") args.push("--first-parent");
    return args;
  }

  // The DAG. --topo-order keeps a branch's commits together instead of
  // interleaving them by date, which is what makes the lanes readable.
  router.get("/log", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(5000, Math.floor(rawLimit)) : 300;
    const rawSkip = Number(req.query.skip);
    const skip = Number.isFinite(rawSkip) && rawSkip > 0 ? Math.floor(rawSkip) : 0;
    try {
      const remoteNames = (await git(["remote"], root)).split("\n").map((r) => r.trim()).filter(Boolean);
      const scope = logScope(req.query);
      const filters = logFilters(req.query);
      // The trailing "--" keeps a ref name that also names a file from being
      // read as a path.
      const raw = await git(
        [
          "log",
          "--topo-order",
          `--format=${LOG_FORMAT}`,
          "-n",
          String(limit),
          "--skip",
          String(skip),
          ...filters,
          ...scope,
          "--",
        ],
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
        const counted = await git(["rev-list", "--count", ...filters, ...scope, "--"], root, LOG_TIMEOUT);
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

  // ---- The branch filter's listing ----
  //
  // Names and nothing else: the filter menu needs something to tick, not the
  // per-ref detail git-scm's BRANCHES pane renders. Branches come back
  // most-recently-committed first, which is the order someone picking "the
  // one I was just on" wants.
  router.get("/refs", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    try {
      const [rawLocal, rawRemote, rawTags, head] = await Promise.all([
        git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"], root),
        git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/remotes"], root),
        git(["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)", "refs/tags"], root),
        git(["symbolic-ref", "--short", "-q", "HEAD"], root).catch(() => ""),
      ]);
      const names = (raw) =>
        raw
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
      res.json({
        current: head.trim() || null,
        local: names(rawLocal),
        // "origin/HEAD" is a pointer at the remote's default branch, not a
        // branch of its own - ticking it would duplicate whatever it points
        // at.
        remotes: names(rawRemote).filter((name) => !name.endsWith("/HEAD")),
        tags: names(rawTags),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // How far back the author list looks. `git shortlog` would walk the whole
  // history to build the same list; one bounded log is enough to offer the
  // people who actually show up in a graph, and the README says so.
  const AUTHOR_SCAN = 5000;

  // The author filter's listing, over whatever the branch filter is showing:
  // narrowing to one branch should offer that branch's authors.
  router.get("/authors", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    try {
      const raw = await git(
        ["log", "--format=%an%x1f%ae", "-n", String(AUTHOR_SCAN), ...logScope(req.query), "--"],
        root,
        LOG_TIMEOUT,
      );
      const counts = new Map();
      for (const line of raw.split("\n")) {
        if (!line) continue;
        const [name, email] = line.split("\x1f");
        if (!name) continue;
        const entry = counts.get(name) ?? { name, email: email ?? "", commits: 0 };
        entry.commits++;
        counts.set(name, entry);
      }
      const authors = [...counts.values()].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
      res.json({ authors, scanned: Math.min(AUTHOR_SCAN, raw.split("\n").filter(Boolean).length) });
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
    // WORKING is the graph's Uncommitted Changes row: HEAD against the file
    // on disk, the whole of what a commit right now would record (staged
    // and unstaged alike, which is what the row counts).
    if (hash === WORKING) {
      await workingDiffSides(root, relPath, req, res);
      return;
    }
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

  async function workingDiffSides(root, relPath, req, res) {
    const abs = relPath ? resolveSafePath(root, relPath) : null;
    if (!abs) {
      res.status(400).json({ error: "path is required and must stay inside the repository" });
      return;
    }
    const oldPath = typeof req.query.oldPath === "string" && req.query.oldPath ? req.query.oldPath : relPath;
    if (!resolveSafePath(root, oldPath)) {
      res.status(400).json({ error: "oldPath escapes the repository root" });
      return;
    }
    let before = "";
    let inHead = true;
    try {
      before = await git(["show", `HEAD:${oldPath}`], root);
    } catch {
      inHead = false;
    }
    const fs = await import("node:fs");
    const onDisk = fs.existsSync(abs);
    res.json({
      original: { content: before, label: inHead ? "HEAD" : "HEAD (new file)" },
      // The right side is the file itself, so it is editable - the same
      // thing git-scm's Working Tree diff offers - unless it was deleted.
      modified: onDisk
        ? { content: fs.readFileSync(abs, "utf8"), label: "Working Tree", path: abs }
        : { content: "", label: "Working Tree (deleted)", readOnlyReason: "This file was deleted." },
    });
  }

  // ---- Uncommitted changes ----
  //
  // Everything a commit right now would record, against HEAD: staged,
  // unstaged and untracked, in one list. The graph draws it as a row above
  // HEAD. `summary=1` returns only the count and a digest - what the poll
  // needs to notice a change - without the per-file numstat.
  function statusLetter(xy) {
    if (xy === "??") return "U";
    // Both sides modified, or added/deleted by both: an unresolved merge.
    if (xy.includes("U") || xy === "AA" || xy === "DD") return "!";
    if (xy.includes("R")) return "R";
    if (xy.includes("D")) return "D";
    if (xy[0] === "A") return "A";
    return "M";
  }

  function parseStatusZ(raw) {
    const tokens = raw.split("\0");
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.length < 4) continue;
      const xy = token.slice(0, 2);
      const filePath = token.slice(3);
      let oldPath = null;
      // A rename or copy carries its source as the next NUL-separated field.
      if (xy.includes("R") || xy.includes("C")) oldPath = tokens[++i] ?? null;
      out.push({ path: filePath, oldPath, status: statusLetter(xy) });
    }
    return out;
  }

  router.get("/uncommitted", async (req, res) => {
    const root = await requireRoot(req, res);
    if (!root) return;
    try {
      let head = null;
      try {
        head = (await git(["rev-parse", "HEAD"], root)).trim();
      } catch {
        // An unborn branch: nothing to draw a row above.
      }
      const raw = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
      const entries = head ? parseStatusZ(raw) : [];
      const digest = createHash("sha1").update(`${head}\n${raw}`).digest("hex");
      if (req.query.summary === "1") {
        res.json({ head, count: entries.length, digest });
        return;
      }
      let numstat = new Map();
      try {
        numstat = parseNumstatZ(await git(["diff", "HEAD", "--numstat", "-z", "-M"], root));
      } catch {
        // Counts are decoration; the list stands without them.
      }
      const files = entries.map((entry) => {
        const counts = numstat.get(entry.path);
        return {
          path: entry.path,
          oldPath: entry.oldPath,
          status: entry.status,
          added: counts?.added ?? 0,
          removed: counts?.removed ?? 0,
          binary: counts?.binary ?? false,
        };
      });
      files.sort((a, b) => a.path.localeCompare(b.path));
      res.json({ head, count: files.length, digest, files });
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
