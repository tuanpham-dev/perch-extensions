// The shapes server.js answers with, in one place rather than inline in
// client.tsx - the pure models beside this file, and their tests, need them
// too and can't import a React tree to get them. Every field here is one
// server.js actually emits; keep the two in step.

export interface StatusResponse {
  configured: boolean;
  hasToken: boolean;
  authed: boolean;
  user: { accountId: string | null; displayName: string | null } | null;
  // The MAIN worktree of the active folder's repository - the key a project
  // mapping is written under, and the {repo} the start form resolves
  // jira.worktreeLocation against. Null outside a repository.
  repo: string | null;
  projectKey: string | null;
  projectSource: string | null;
  error: string | null;
}

export interface IssueRow {
  key: string;
  summary: string;
  status: string;
  // "new" | "indeterminate" | "done" - the only part of a status that is
  // stable across projects, since status NAMES are per-workflow.
  statusCategory: string | null;
  type: string;
  assignee: string | null;
  priority: string | null;
  // For grouping by project. Optional: a row from an older server lacks them,
  // and groupModel falls back to the key's prefix.
  projectKey?: string | null;
  projectName?: string | null;
  updated: string | null;
  url: string;
}

export interface IssuesResponse {
  issues: IssueRow[];
  projectKey: string | null;
  projectSource: string | null;
}

export interface IssueComment {
  author: string;
  created: string | null;
  body: string;
}

export interface IssueDetail {
  key: string;
  summary: string;
  // Markdown (GFM), rendered from Jira's ADF by server.js's adfToMarkdown -
  // as are the comment bodies.
  description: string;
  status: string;
  // Optional because a detail built before these fields existed - a test
  // fixture, or an older server - simply lacks them; the view hides a
  // missing one.
  statusCategory?: string | null;
  type: string;
  priority: string | null;
  labels: string[];
  assignee?: string | null;
  reporter?: string | null;
  created?: string | null;
  updated?: string | null;
  comments: IssueComment[];
  url: string;
}

export interface WorktreeResponse {
  path: string;
  branch: string;
  base: string;
  note: string | null;
}

export interface ProgressResponse {
  transitioned: boolean;
  assigned: boolean;
  note: string | null;
}

// GET /facets. A facet whose Jira metadata call failed arrives as an empty
// array; the popover leaves that section out rather than showing it empty.
export interface FacetName {
  name: string;
  // Present for statuses only, and only when Jira reported one.
  category?: string | null;
}

export interface FacetUser {
  accountId: string;
  displayName: string;
}

export interface Facets {
  statuses: FacetName[];
  assignees: FacetUser[];
  types: FacetName[];
  priorities: FacetName[];
}

// GET /worktrees. `path` is absolute, which is what openSessionWindow's
// createCwd takes; `displayPath` has $HOME shortened to "~", which is the
// convention core reports a session's path in - so that is the half to match
// sessions on. See server.js's shortenHome.
export interface WorktreeRow {
  path: string;
  displayPath: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  main: boolean;
}

export interface ProjectRow {
  key: string;
  name: string;
}

// A context-menu row, as the host's showMenu takes them. Not a server shape
// like the rest of this file, but it is the one type several components need
// and none of them can take it from client.tsx without closing an import
// cycle.
export interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
  // Leading check icon. The host has supported this all along (see core's
  // MenuItem in client/src/types.ts); this structural copy just never
  // declared it.
  checked?: boolean;
  // Thin divider row - label/onClick are unused placeholders on one.
  separator?: boolean;
}
