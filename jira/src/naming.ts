// Branch and session names for "Start work". Moved out of client.tsx so the
// start-work form can prefill a branch from the same function that creates
// one, and so both are testable without a React tree.
import type { IssueRow } from "./types.ts";

// Byte-identical to the bundled worktrees extension's own sessionNameFor -
// session names can't contain "." or ":".
export function sessionNameFor(branch: string): string {
  return branch.replace(/[.:/\s]+/g, "-").replace(/^-+|-+$/g, "");
}

export function shortSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "untitled";
}

// {key}/{slug}/{type} - so both "CAP-123-fix-header" and "feature/CAP-123"
// conventions are reachable from one setting. github hardcodes its
// equivalent; Jira branch conventions vary too much between teams for that.
export function buildBranch(template: string, issue: IssueRow): string {
  const type = issue.type.toLowerCase() === "bug" ? "bugfix" : "feature";
  const filled = (template.trim() || "{key}-{slug}")
    .replaceAll("{key}", issue.key)
    .replaceAll("{slug}", shortSlug(issue.summary))
    .replaceAll("{type}", type);
  return filled.replace(/^-+|-+$/g, "") || issue.key;
}
