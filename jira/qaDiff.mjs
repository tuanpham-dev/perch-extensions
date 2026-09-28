// What one ticket changed on the QA branch, as a unified diff: from the
// commit before its own (the parent of the ticket's QA commit) to the
// ticket's commit, plus - while a change request is being worked - the QA
// worktree's uncommitted edits, which are that same ticket's and get amended
// into its commit on approval.
//
// Normally the ticket being fixed is the tip of the branch, and then the two
// read as one diff against the parent: `git diff <parent>` compares the
// working tree with it, committed and uncommitted together. When other
// tickets have been merged on top since, that would sweep their commits in
// too, so the ticket's commit and the uncommitted edits come back as two
// separate sections instead.
//
// Plain ESM with git and the file reader passed in, so the tests can drive
// it against a scratch repository and server.js can hand it its own runner.

// git's well-known empty tree: the "parent" of a root commit.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// A diff past this is cut at a file boundary. A ticket that big is not read
// in a side pane anyway, and the whole patch travels in one JSON response.
export const MAX_PATCH_BYTES = 1_500_000;
// Untracked files are read whole to be shown as added; past this size, or
// with a NUL byte in them, they are listed as binary instead.
const MAX_UNTRACKED_BYTES = 256_000;
const MAX_UNTRACKED_FILES = 200;

const DIFF_ARGS = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "-M"];

// A new file as git would print it, for a path git does not track yet.
// `git diff --no-index` would do it, but it exits 1 whenever the files
// differ - which for an added file is always - and the runner treats a
// non-zero exit as a failure.
export function untrackedPatch(file, content) {
  const header = `diff --git a/${file} b/${file}\nnew file mode 100644\n`;
  if (content === null) return `${header}Binary files /dev/null and b/${file} differ\n`;
  if (content === "") return header;
  const lines = content.split("\n");
  const noNewline = lines[lines.length - 1] !== "";
  if (!noNewline) lines.pop();
  const body = lines.map((line) => `+${line}\n`).join("");
  return (
    `${header}--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${body}` +
    (noNewline ? "\\ No newline at end of file\n" : "")
  );
}

// Keeps whole files: cutting inside a hunk would leave a patch the parser
// has to guess about.
export function capPatch(patch, max = MAX_PATCH_BYTES) {
  if (patch.length <= max) return { patch, truncated: false };
  const cut = patch.lastIndexOf("\ndiff --git ", max);
  return { patch: cut > 0 ? patch.slice(0, cut + 1) : patch.slice(0, max), truncated: true };
}

async function untrackedFiles(git, cwd, readFile) {
  const out = await git(["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z"], cwd);
  const files = out.split("\0").filter(Boolean).sort();
  const patches = [];
  for (const file of files.slice(0, MAX_UNTRACKED_FILES)) {
    let content = null;
    try {
      const buf = await readFile(file);
      if (buf.length <= MAX_UNTRACKED_BYTES && !buf.includes(0)) content = buf.toString("utf8");
    } catch {
      // Gone between the listing and the read, or unreadable: show it as
      // present but without content rather than failing the whole diff.
    }
    patches.push(untrackedPatch(file, content));
  }
  return { patch: patches.join(""), skipped: Math.max(0, files.length - MAX_UNTRACKED_FILES) };
}

async function resolve(git, cwd, rev) {
  return (await git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cwd)).trim();
}

// `commit` is the ticket's commit on the QA branch; `withUncommitted` says the
// worktree's pending edits are this ticket's (its change request is open).
export async function buildQaDiff({ git, cwd, commit, withUncommitted, readFile }) {
  const full = await resolve(git, cwd, commit).catch(() => "");
  if (!full) throw Object.assign(new Error(`${commit} is not in the QA worktree any more`), { status: 409 });
  const head = await resolve(git, cwd, "HEAD");
  const parent = await resolve(git, cwd, `${full}^`).catch(() => "");
  const base = parent || EMPTY_TREE;

  const sections = [];
  let untrackedSkipped = 0;
  const pending = async () => {
    const untracked = await untrackedFiles(git, cwd, readFile);
    untrackedSkipped = untracked.skipped;
    return untracked.patch;
  };

  if (withUncommitted && full === head) {
    // Parent against the working tree: the commit and the edits as one.
    const tracked = await git([...DIFF_ARGS, base, "--"], cwd);
    sections.push({ label: "", patch: tracked + (await pending()) });
  } else {
    sections.push({ label: withUncommitted ? "Committed" : "", patch: await git([...DIFF_ARGS, base, full, "--"], cwd) });
    if (withUncommitted) {
      const tracked = await git([...DIFF_ARGS, "HEAD", "--"], cwd);
      sections.push({ label: "Uncommitted", patch: tracked + (await pending()) });
    }
  }

  let budget = MAX_PATCH_BYTES;
  let truncated = false;
  for (const section of sections) {
    const capped = capPatch(section.patch, Math.max(0, budget));
    section.patch = capped.patch;
    truncated ||= capped.truncated;
    budget -= capped.patch.length;
  }

  return {
    base: parent ? parent.slice(0, 7) : "",
    commit: full.slice(0, 7),
    head: head.slice(0, 7),
    // Whether the uncommitted edits were folded into the one section.
    combined: withUncommitted && full === head,
    withUncommitted: Boolean(withUncommitted),
    sections,
    truncated,
    untrackedSkipped,
  };
}
