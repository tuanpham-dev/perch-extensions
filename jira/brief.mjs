// What an agent is handed: a ticket's brief, several tickets as one message,
// and the four batch messages built on top of them.
//
// Plain ESM rather than TypeScript, and outside src/, because BOTH sides need
// it: the bundled client imports it through src/brief.ts, and server.js -
// which the host loads as plain JS, with no TypeScript loader of its own -
// imports it directly. One copy of the wording, so what a worker is told at
// launch and what `jira-batch brief` prints back can never drift apart.
// src/brief.d.mts types it for the client's typecheck.

// Everything the agent needs to start without going back to Jira itself. The
// description alone was not enough in practice: on a real ticket the
// decisions tend to live in the comment thread, so those go in too (oldest
// first, capped by jira.commentLimit). The URL is included so the agent can
// cite it or ask the user to open it.
export function buildAgentBrief(detail) {
  const lines = [`${detail.key}: ${detail.summary}`, ""];

  const facts = [
    detail.type && `Type: ${detail.type}`,
    detail.status && `Status: ${detail.status}`,
    detail.priority && `Priority: ${detail.priority}`,
    detail.labels.length > 0 && `Labels: ${detail.labels.join(", ")}`,
    `Link: ${detail.url}`,
  ].filter((line) => typeof line === "string" && line.length > 0);
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
export function buildCombinedBrief(details) {
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

// ---- Batch messages ----
//
// A cluster's worker is long-lived: it works several tickets in order,
// reports each one, and then STAYS at its prompt, because rework and more
// tickets arrive later as new messages. That is the whole difference from
// "Start work", whose agent is handed everything once and is never spoken to
// again, and it is why the rules below are part of the brief rather than
// something the panel hopes the agent infers.

// The three verbs a worker must use, in the order it will need them. Kept as
// one list so the launch brief and every follow-up message quote the same
// text - a worker reminded of a rule it was never given reads as a bug.
const RULES = [
  "Work the tickets in the order they are listed.",
  "Before you start a ticket, run `jira-batch start <KEY>`.",
  "Commit each ticket's work on this branch as `[<KEY>] <what changed>` - one commit per ticket.",
  'QA it, then run `jira-batch qa <KEY> --status pass|fail|partial|blocked` with what was wrong, what you changed, how to check it, and a before and after image when there is something to see.',
  'Then run `jira-batch done <KEY> --summary "<what you changed>"`.',
  'Run `jira-batch fail <KEY> --reason "<why>"` if a ticket cannot be done, and carry on with the next one.',
  "Never invent a fix for a ticket that is not a real code problem - report it as blocked with the reason instead.",
  "Never push. Every commit stays on this branch until someone asks otherwise.",
  "When every ticket is reported, stay at this prompt: feedback on your work may arrive as a new message.",
];

// Which skill answers for each half of the work. The extension resolves them
// and names them here; it never says HOW to implement or QA anything, because
// that is what the named skill is for. A slot with no skill is the agent's
// own judgement, and saying so plainly beats leaving it to be inferred.
function skillLines(skills) {
  if (!skills) return [];
  const lines = [];
  const exec = skills.execution;
  if (exec && exec.name && !exec.missing) {
    lines.push(`Implement each ticket with the \`${exec.name}\` skill, using --current-branch: this worktree is already on the right branch and you must never create another.`);
  } else if (exec && exec.missing) {
    lines.push(`The execution skill that was chosen (${exec.wanted}) is not installed. Work the tickets yourself, following the rules below.`);
  } else if (skills.execFallback) {
    lines.push("No execution skill is installed. Work each ticket yourself: read it, change the smallest thing that satisfies it, and keep unrelated edits out of the commit.");
  } else {
    lines.push("No execution skill is set: how to implement each ticket is your own judgement.");
  }

  const qa = skills.qa;
  if (qa && qa.name && !qa.missing) {
    lines.push(`QA each ticket with the \`${qa.name}\` skill before you report it done.`);
  } else if (qa && qa.missing) {
    lines.push(`The QA skill that was chosen (${qa.wanted}) is not installed. Check your own work before reporting it, and say in the report how you checked it.`);
  } else {
    lines.push("No QA skill is set: how to check each ticket is your own judgement, but the report is still required.");
  }
  return lines;
}

function rulesBlock() {
  return ["## Rules", "", ...RULES.map((rule, i) => `${i + 1}. ${rule}`)].join("\n");
}

function ticketLine(detail) {
  return `${detail.key}: ${detail.summary}`;
}

// The brief a cluster's agent is launched with, and what `jira-batch brief`
// prints back at any time.
export function buildClusterBrief({ batchName, clusterName, criteria, rationale, files = [], details, skills = null }) {
  const keys = details.map((detail) => detail.key);
  const lines = [
    `# Jira batch "${batchName}" - cluster "${clusterName}"`,
    "",
    `${details.length} ${details.length === 1 ? "ticket" : "tickets"} to implement in this worktree, in order: ${keys.join(", ")}`,
  ];
  if (rationale) lines.push("", `Why these are one cluster: ${rationale}`);
  if (files.length > 0) lines.push("", `Expected to touch: ${files.join(", ")}`);
  if (criteria) lines.push("", `How this batch was split: ${criteria}`);
  const skillsSaid = skillLines(skills);
  if (skillsSaid.length > 0) lines.push("", "## How to do the work", "", ...skillsSaid.map((line) => `- ${line}`));
  lines.push(
    "",
    rulesBlock(),
    "",
    "`jira-batch brief` prints this again, and `jira-batch help` lists every verb.",
    "",
    "---",
    "",
    "Each ticket follows in full, in the order above.",
  );
  for (const detail of details) lines.push("", "---", "", buildAgentBrief(detail));
  return lines.join("\n").trimEnd();
}

// The same brief as ONE line, to ride on the launch command as the agent's
// first prompt.
//
// It cannot be sent as a second message: the launch line starts a process
// that takes seconds to come up - Claude Code opens with a folder-trust
// prompt of its own - and anything typed in the meantime goes into the
// shell's buffer instead, where the agent never sees it. (The agent-tasks
// extension learned this first; see its preamble.mjs.) One line because a
// newline inside a quoted shell argument is a continuation prompt, not text.
//
// What does not fit rides in `jira-batch brief`, which prints the full text
// above at any time - so the line carries the rules and the ticket keys, and
// points at the rest.
const LINE_MAX = 1500;

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function buildClusterBriefLine({ batchName, clusterName, criteria, details, skills = null }) {
  const keys = details.map((detail) => detail.key);
  let tickets = details.map((detail) => `${detail.key}: ${oneLine(detail.summary)}`).join("; ");
  if (tickets.length > LINE_MAX) tickets = `${tickets.slice(0, LINE_MAX)}... (run \`jira-batch brief\` for all of them)`;
  return [
    `You are the agent for cluster "${oneLine(clusterName)}" of the Jira batch "${oneLine(batchName)}", working in this worktree.`,
    `Tickets, in order: ${keys.join(", ")}.`,
    tickets ? `They are: ${tickets}.` : "",
    criteria ? `The batch was split by: ${oneLine(criteria)}` : "",
    ...skillLines(skills).map((line) => oneLine(line)),
    `Rules: ${RULES.map((rule, i) => `(${i + 1}) ${rule}`).join(" ")}`,
    "Run `jira-batch brief` now to read each ticket in full before you start.",
  ]
    .filter(Boolean)
    .join(" ");
}

// Tickets added to a cluster that is already running. The worker is mid-flow,
// so this names what is new rather than restating the cluster, and reminds it
// of the per-ticket verbs without repeating the whole rule list.
export function buildAdditionalTicketsMessage({ clusterName, details }) {
  const keys = details.map((detail) => detail.key);
  const lines = [
    `Additional tickets for cluster "${clusterName}": ${keys.join(", ")}`,
    "",
    "Add them to the end of your queue and work them after what you already have.",
    "Same rules as before: `jira-batch start <KEY>` before each, one `[<KEY>] ...` commit each, then `jira-batch done <KEY> --summary \"...\"`.",
  ];
  for (const detail of details) lines.push("", "---", "", buildAgentBrief(detail));
  return lines.join("\n").trimEnd();
}

// Reviewed work sent back. Several tickets at once, because the reviewer
// reads a column and answers it in one pass - one message per ticket would be
// one prompt per ticket, and the agent would start on the first before seeing
// the rest.
export function buildFeedbackMessage({ clusterName, items }) {
  const lines = [
    `Rework requested on ${items.length} ${items.length === 1 ? "ticket" : "tickets"} in cluster "${clusterName}":`,
  ];
  for (const item of items) {
    lines.push("", `### ${item.key} - ${item.summary}`, "", item.feedback.trim());
  }
  lines.push(
    "",
    "---",
    "",
    'For each: make the change, commit it as `[<KEY>] ...`, then run `jira-batch done <KEY> --summary "..."` again.',
  );
  return lines.join("\n").trimEnd();
}

// Sent to a worker started fresh after its window died. It has no memory of
// the run, so this says where the cluster stands; the full brief is one
// command away rather than pasted again.
export function buildResumeMessage({ clusterName, remaining }) {
  const lines = [`Resuming cluster "${clusterName}".`];
  if (remaining.length === 0) {
    lines.push("", "Every ticket is reported. Stay at this prompt: feedback may arrive as a new message.");
  } else {
    lines.push("", "Where the tickets stand:");
    for (const ticket of remaining) lines.push(`- ${ticketLine(ticket)} - ${ticket.state}`);
    lines.push("", "Carry on with the ones that are not done yet.");
  }
  lines.push("", "Run `jira-batch brief` for the full brief and the rules.");
  return lines.join("\n").trimEnd();
}
