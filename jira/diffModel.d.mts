// Types for diffModel.mjs, which is plain ESM so the tests run it directly.
// The client's typecheck resolves "../diffModel.mjs" to this file.

export type DiffLineKind = "add" | "del" | "ctx" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  // The function or heading git printed after the second @@, if any.
  section: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export declare function parseUnifiedDiff(text: string): DiffFile[];
export declare function diffTotals(files: DiffFile[]): { files: number; additions: number; deletions: number };
