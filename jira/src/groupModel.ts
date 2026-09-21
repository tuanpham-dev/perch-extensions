// Group by project: the list split into one section per Jira project. Pure
// arrangement of the rows that came back - grouping never changes the query.
import type { IssueRow } from "./types.ts";

export interface IssueGroup {
  key: string;
  name: string;
  issues: IssueRow[];
}

// The project a row belongs to. A row from an older server has no project
// field, and every Jira issue key is "<PROJECT>-<number>", so the prefix
// stands in.
export function projectOf(issue: IssueRow): { key: string; name: string } {
  const prefix = issue.key.replace(/-\d+$/, "");
  const key = issue.projectKey || prefix;
  return { key, name: issue.projectName || key };
}

// Sections in the order their first ticket appears, so the chosen sort still
// decides what comes first: sorted by updated, the project with the newest
// work leads. Tickets keep their sorted order inside a section.
export function groupByProject(issues: readonly IssueRow[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const issue of issues) {
    const { key, name } = projectOf(issue);
    let group = groups.get(key);
    if (!group) {
      group = { key, name, issues: [] };
      groups.set(key, group);
    }
    group.issues.push(issue);
  }
  return [...groups.values()];
}

// Issue keys in the order they are displayed, leaving out collapsed sections.
// A shift-click range runs over what is on screen - a range that silently
// took in tickets hidden inside a collapsed section would select things the
// user never saw.
export function displayKeys(groups: readonly IssueGroup[], collapsed: ReadonlySet<string>): string[] {
  return groups.filter((group) => !collapsed.has(group.key)).flatMap((group) => group.issues.map((issue) => issue.key));
}
