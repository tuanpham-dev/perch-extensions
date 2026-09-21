// What the agent is handed when work starts. Moved out of client.tsx so the
// single-ticket brief and the several-ticket one are built by the same code
// and can be pinned by tests.
import type { IssueDetail } from "./types.ts";

// Everything the agent needs to start without going back to Jira itself. The
// description alone was not enough in practice: on a real ticket the
// decisions tend to live in the comment thread, so those go in too (oldest
// first, capped by jira.commentLimit). The URL is included so the agent can
// cite it or ask the user to open it.
export function buildAgentBrief(detail: IssueDetail): string {
  const lines: string[] = [`${detail.key}: ${detail.summary}`, ""];

  const facts = [
    detail.type && `Type: ${detail.type}`,
    detail.status && `Status: ${detail.status}`,
    detail.priority && `Priority: ${detail.priority}`,
    detail.labels.length > 0 && `Labels: ${detail.labels.join(", ")}`,
    `Link: ${detail.url}`,
  ].filter((line): line is string => typeof line === "string" && line.length > 0);
  lines.push(...facts, "");

  lines.push("## Description", detail.description || "(none)");

  if (detail.comments.length > 0) {
    lines.push("", `## Comments (${detail.comments.length}, oldest first)`);
    for (const comment of detail.comments) {
      const when = comment.created ? ` on ${comment.created.slice(0, 10)}` : "";
      lines.push("", `### ${comment.author}${when}`, comment.body);
    }
  }

  return lines.join("\n").trimEnd();
}

// Several tickets going into one worktree arrive as ONE message rather than
// one per ticket: each send is a separate paste into the agent's composer, so
// N of them would be N prompts and the agent would start on the first before
// it had seen the rest. The heading names every key up front, because an
// agent that reads only the first screen should still know how many tickets
// it is holding. One ticket is byte-identical to buildAgentBrief, so the
// single-ticket path is unchanged.
export function buildCombinedBrief(details: IssueDetail[]): string {
  if (details.length === 0) return "";
  if (details.length === 1) return buildAgentBrief(details[0]);

  const keys = details.map((detail) => detail.key);
  const lines = [
    `${details.length} Jira tickets to implement in this worktree: ${keys.join(", ")}`,
    "",
    "Each ticket follows in full, in the order they were selected.",
  ];
  for (const detail of details) lines.push("", "---", "", buildAgentBrief(detail));
  return lines.join("\n").trimEnd();
}
