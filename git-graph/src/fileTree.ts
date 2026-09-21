// An expanded commit's files as the rows the view draws: either the flat
// list of paths, or a folder tree like SOURCE CONTROL's "View as Tree".
//
// Both views come out as one flat array of rows, because that is what the
// virtualizer sizes a row by: an expanded commit is ROW_HEIGHT plus one file
// row's height per entry here, whichever view is on and whichever folders
// are collapsed.
//
// Folders with a single child folder and no files of their own are joined
// into one row ("src/components"), the way VS Code's compact folders do -
// otherwise a deep path is a staircase of rows with nothing on them.

export type FileView = "list" | "tree";

export interface DirRow {
  kind: "dir";
  // The folder's full path from the repository root, which is also its key
  // in the collapsed set.
  path: string;
  // What the row shows: the folder's name, or several joined by "/".
  name: string;
  depth: number;
  collapsed: boolean;
  // Files anywhere underneath, for the count a collapsed folder shows.
  fileCount: number;
}

export interface FileRow<T> {
  kind: "file";
  // The basename in a tree, the whole path in the list.
  name: string;
  depth: number;
  file: T;
}

export type TreeRow<T> = DirRow | FileRow<T>;

interface DirNode<T> {
  name: string;
  path: string;
  dirs: Map<string, DirNode<T>>;
  files: T[];
}

function newDir<T>(name: string, path: string): DirNode<T> {
  return { name, path, dirs: new Map(), files: [] };
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function countFiles<T>(node: DirNode<T>): number {
  let n = node.files.length;
  for (const child of node.dirs.values()) n += countFiles(child);
  return n;
}

export function fileRows<T extends { path: string }>(
  files: T[],
  view: FileView,
  collapsed: ReadonlySet<string> = new Set(),
): TreeRow<T>[] {
  if (view === "list") return files.map((file) => ({ kind: "file", name: file.path, depth: 0, file }));

  const root = newDir<T>("", "");
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      let child = node.dirs.get(name);
      if (!child) {
        child = newDir(name, node.path ? `${node.path}/${name}` : name);
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.push(file);
  }

  const rows: TreeRow<T>[] = [];
  const walk = (node: DirNode<T>, depth: number) => {
    // Folders first, then files, each alphabetically: the order every file
    // tree in the app already uses.
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (let dir of dirs) {
      let name = dir.name;
      while (dir.files.length === 0 && dir.dirs.size === 1) {
        const only = dir.dirs.values().next().value as DirNode<T>;
        name = `${name}/${only.name}`;
        dir = only;
      }
      const isCollapsed = collapsed.has(dir.path);
      rows.push({ kind: "dir", path: dir.path, name, depth, collapsed: isCollapsed, fileCount: countFiles(dir) });
      if (!isCollapsed) walk(dir, depth + 1);
    }
    const sorted = [...node.files].sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
    for (const file of sorted) rows.push({ kind: "file", name: basename(file.path), depth, file });
  };
  walk(root, 0);
  return rows;
}
