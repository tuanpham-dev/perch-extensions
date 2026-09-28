// Unified diff text into files, hunks and numbered lines, for the QA
// branch's Changes view. Plain ESM so the tests run it under node directly;
// the client's typecheck resolves "../diffModel.mjs" to diffModel.d.mts.
//
// Only what `git diff` prints is understood: a `diff --git` line opens each
// file, extended headers (new/deleted mode, rename, Binary) describe it, and
// `@@` hunks carry the lines.

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// The b/ side of `diff --git a/x b/x`. Only a fallback - the ---/+++ and
// rename lines are unambiguous where this is not (a path with " b/" in it).
function pathsFromDiffLine(line) {
  const rest = line.slice("diff --git ".length);
  const mid = rest.indexOf(" b/");
  if (!rest.startsWith("a/") || mid < 0) return { oldPath: rest, newPath: rest };
  return { oldPath: rest.slice(2, mid), newPath: rest.slice(mid + 3) };
}

function stripSide(value, prefix) {
  const path = value.replace(/\t.*$/, "");
  if (path === "/dev/null") return null;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const { oldPath, newPath } = pathsFromDiffLine(line);
      file = { path: newPath, oldPath, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) {
        file.oldPath = line.slice("rename from ".length);
        file.status = "renamed";
      } else if (line.startsWith("rename to ")) file.path = line.slice("rename to ".length);
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") file.binary = true;
      else if (line.startsWith("--- ")) {
        const old = stripSide(line.slice(4), "a/");
        if (old !== null) file.oldPath = old;
      } else if (line.startsWith("+++ ")) {
        const next = stripSide(line.slice(4), "b/");
        if (next !== null) file.path = next;
      }
    }

    const header = HUNK.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      hunk = { header: line, section: header[5].trim(), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    const mark = line[0];
    if (mark === "+") {
      hunk.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newLine++ });
      file.additions++;
    } else if (mark === "-") {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldLine++, newNo: null });
      file.deletions++;
    } else if (mark === " ") {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldLine++, newNo: newLine++ });
    } else if (mark === "\\") {
      hunk.lines.push({ kind: "note", text: line.slice(2), oldNo: null, newNo: null });
    }
    // Anything else (the empty string after the final newline) ends nothing
    // and adds nothing.
  }

  // A deleted file keeps its old name as its name.
  for (const f of files) if (f.status === "deleted") f.path = f.oldPath;
  return files;
}

export function diffTotals(files) {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: files.length, additions, deletions };
}
