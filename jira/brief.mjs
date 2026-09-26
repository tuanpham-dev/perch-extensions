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


// ---- The QA agent ----
//
// One agent per batch, in a worktree on the QA branch. It is briefed once on
// the launch line, then instructed one action at a time as the reviewer
// decides: each instruction below is what the panel types into its terminal.
// They are short and imperative because the procedure itself lives in the
// skill; these only say which ticket, and which cluster branch to take it
// from.

const QA_RULES = [
  "Never push anything.",
  "One squashed commit per ticket on this branch, its subject starting with the ticket key in brackets.",
  "A change the reviewer asks for is made in the worktree and NOT committed until they approve; approval amends it into that ticket's commit.",
  "Report every step with the `jira-batch qa-*` verbs, or the board cannot show it.",
  "Do nothing to a ticket the panel has not asked about.",
];

export function buildQaBriefLine({ batchName, branch, productionBranch, tickets, skills = null, resumed = false }) {
  const keys = tickets.map((ticket) => ticket.key);
  let list = tickets.map((ticket) => `${ticket.key} (${ticket.branch})`).join(", ");
  if (list.length > LINE_MAX) list = `${list.slice(0, LINE_MAX)}...`;
  return [
    `You are the QA agent for the Jira batch "${oneLine(batchName)}", working in this worktree on the branch ${branch}, cut from ${productionBranch}.`,
    `You will merge these tickets onto it one at a time as the panel asks, each from the cluster branch named beside it: ${list}.`,
    `Reviewed tickets, in priority order: ${keys.join(", ")}.`,
    ...skillLines(skills).map((line) => oneLine(line)),
    `Rules: ${QA_RULES.map((rule, i) => `(${i + 1}) ${rule}`).join(" ")}`,
    resumed
      ? "You are replacing an agent that died mid-run: read `git status` and `git log --oneline -10` first, since a fix may be sitting uncommitted, then take over the dev server, report `jira-batch qa-start`, and wait for the panel."
      : "Start by taking over the dev server and reporting `jira-batch qa-start`, then wait for the panel.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildQaMergeMessage({ key, summary, sourceBranch }) {
  return [
    `Merge ${key} - ${oneLine(summary)}`,
    "",
    `Its commits are the ones whose subject starts with \`[${key}]\` on \`${sourceBranch}\`. Squash them into one commit on this branch, restart the server, then run \`jira-batch qa-merged ${key} --commit <sha>\`.`,
  ].join("\n");
}

export function buildQaFixMessage({ key, change }) {
  return [
    `Change ${key}:`,
    "",
    change.trim(),
    "",
    `Make it in this worktree and do not commit. Restart the server, then run \`jira-batch qa-fixing ${key} --what "..."\`.`,
  ].join("\n");
}

export function buildQaApproveMessage({ key }) {
  return `Approve ${key}. If the tree carries an uncommitted fix, amend it into ${key}'s commit; then run \`jira-batch qa-approved ${key} --commit <sha>\`.`;
}

export function buildQaDropMessage({ key, commit, why }) {
  const reason = why ? ` (${oneLine(why)})` : "";
  return commit
    ? `Exclude ${key}${reason}. Drop its commit ${commit} from this branch, restart the server, then run \`jira-batch qa-excluded ${key} --why "..."\`.`
    : `Exclude ${key}${reason}. It was never merged, so there is nothing to drop; run \`jira-batch qa-excluded ${key} --why "..."\`.`;
}

export function buildQaShipMessage({ into, branch }) {
  return `Ship into ${into}. Every merged ticket is approved. Rebase ${branch} onto ${into} if it has moved, then in the primary worktree merge ${branch} into ${into} with --no-ff. Do not push. Run \`jira-batch qa-shipped --into ${into}\`.`;
}

// The wording that reaches the note-refining call. Kept here with the other
// prompts so the rule that matters most - keep every claim exactly as strong
// as it was - is written once.
export function buildQaRefinePrompt({ key, summary, note }) {
  return [
    `A reviewer approved Jira ticket ${key} ("${oneLine(summary)}") with this note, typed in shorthand while looking at the page:`,
    "",
    note.trim(),
    "",
    "Rewrite it as one to three plain sentences a teammate who was not present can act on. Expand shorthand and say what each number refers to. Keep every claim exactly as strong as it was: a possibility stays a possibility, a guess stays a guess, and nothing is added. If you cannot restate it without guessing what was meant, answer with exactly the text AS-WRITTEN and nothing else.",
    "",
    "Answer with the rewritten note only, no preamble.",
  ].join("\n");
}


// The Jira comment a handed-off ticket gets. Built from what the batch
// already holds - the QA report's problem, fix and steps, and the note the
// reviewer approved with - so a reviewer who was not here can check the work
// without opening the code. Lines, not markup: the caller wraps them in ADF.
export function buildHandoffComment({ url = "", qa = null, note = "" }) {
  const lines = [];
  lines.push(url ? `Ready for QA on the main theme: ${url}` : "Ready for QA on the main theme.");
  const list = (title, items) => {
    if (!items || items.length === 0) return;
    lines.push("", title);
    for (const item of items) lines.push(`- ${item}`);
  };
  const steps = (title, items) => {
    if (!items || items.length === 0) return;
    lines.push("", title);
    items.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
  };
  if (qa) {
    list("Problem", qa.problem);
    list("Fix", qa.fix);
    steps("How to QA", qa.steps);
  } else {
    lines.push("", "No QA report was filed for this ticket by its agent.");
  }
  if (note && note.trim()) {
    lines.push("", "Notes", note.trim());
  }
  return lines.join("\n");
}


// Told to the cluster whose ticket would not apply onto the QA branch: the
// QA agent could not resolve it without deciding what the ticket meant, and
// that decision is its author's. Same shape as feedback, because that is the
// message this agent already knows how to act on.
export function buildQaConflictMessage({ key, summary, qaBranch, files = [], why = "" }) {
  return [
    `${key} - ${oneLine(summary)} would not apply onto the QA branch ${qaBranch}.`,
    "",
    files.length > 0 ? `Conflict in: ${files.join(", ")}` : "",
    why ? `The QA agent says: ${why.trim()}` : "",
    "",
    `Rebase or rework your \`[${key}]\` commit so it applies cleanly onto ${qaBranch}, then run \`jira-batch done ${key} --summary "..."\` again so it can be merged.`,
  ]
    .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trimEnd();
}

// ---- Reviewing a ticket ----
//
// Two agents, each started with one line on its launch command that tells it
// to fetch its full brief with `jira-review brief` - the same split the batch
// agents use, because a brief with the ticket's whole comment thread does not
// belong on a shell command line.

const REVIEW_RULES = [
  "You review; you do not fix. Never commit, push, open or change the pull request, or edit files in this folder.",
  "Report exactly once with the `jira-review` line below, or the ticket's panel cannot show your work.",
  "If you cannot do the task - no access, no browser, a page that will not load - report that as your result rather than guessing.",
];

export function buildReviewBriefLine({ key, task }) {
  const what = task === "code" ? "code review of its pull request" : "visual QA of its preview theme";
  return [
    `You are doing the ${what} for the Jira ticket ${key}.`,
    "Run `jira-review brief` now: it prints the ticket, what to check and how to report.",
  ].join(" ");
}

// The code reviewer sits in a worktree checked out at the pull request's head,
// so the repository around the diff is on disk to read, grep and run.
export function buildCodeReviewBrief({ detail, pr, worktreePath }) {
  return [
    `# Code review: ${detail.key}, pull request #${pr.number}`,
    "",
    `Pull request: ${pr.url}`,
    worktreePath
      ? `This folder (${worktreePath}) is a checkout of the pull request's head, in a worktree of its own.`
      : "This folder is a checkout of the repository.",
    "",
    "## What to do",
    `1. Read the pull request: \`gh pr view ${pr.url}\` and \`gh pr diff ${pr.url}\`, or your GitHub tool if you have one. Read its description and review comments too.`,
    "2. Read the ticket below and decide whether the change does what it asks, and nothing it does not.",
    "3. Use the repository for context: open the files the diff touches in full, find what calls them and what they call, and check the conventions the codebase already follows.",
    "4. Look for bugs, regressions, missed cases, security and performance problems, and code that should reuse something that already exists. Run cheap checks - a linter, a test file, a theme check - when the repository has them.",
    "5. Keep findings to what a reviewer should act on, each with the file and line it concerns.",
    "",
    "## Rules",
    ...REVIEW_RULES.map((rule) => `- ${rule}`),
    "",
    "## Reporting",
    "When you are done, run this once, with one `--finding` per finding (severity is high, medium or low):",
    "",
    "```sh",
    'jira-review code --verdict approve|request-changes|comment --summary "What you concluded, in two or three sentences" \\',
    '  --finding high:path/to/file.liquid:42:"What is wrong and why" \\',
    '  --finding low:path/to/file.js:7:"..."',
    "```",
    "",
    "## The ticket",
    "",
    buildAgentBrief(detail),
  ].join("\n");
}

// The QA agent compares the live storefront with the preview theme. The
// skill carries the procedure; this carries the facts for this ticket.
export function buildPreviewQaBrief({ detail, preview, liveOrigin, pages, password = "", skillName = "jira-review-qa" }) {
  const pageList = pages.length > 0 ? pages : ["the page the ticket describes - decide from its words"];
  return [
    `# Visual QA: ${detail.key}, preview theme ${preview.themeId}`,
    "",
    `Preview: ${preview.url}`,
    liveOrigin
      ? `Live storefront: ${liveOrigin}`
      : "Live storefront: not known from the link - find the store's domain from the preview page (the theme editor's own link) and say which you used.",
    password ? `Storefront password: ${password}` : "Storefront password: none stored. If the store asks for one, report `blocked` and say so.",
    "Viewports: 1440 wide (desktop) and 390 wide (phone).",
    "",
    "Pages to check:",
    ...pageList.map((page) => `- ${page}`),
    "",
    `Follow the \`${skillName}\` skill in this folder (.claude/skills/${skillName}/SKILL.md) for how to capture and compare.`,
    "",
    "## Rules",
    ...REVIEW_RULES.map((rule) => `- ${rule}`),
    "",
    "## Reporting",
    "When you are done, run this once, with one `--page` group per page and its four captures after it:",
    "",
    "```sh",
    'jira-review qa --status pass|fail|partial|blocked \\',
    '  --checked "What you looked at" --wrong "A defect, one per flag" --note "Anything else" \\',
    "  --page /products/example \\",
    "    --before-1440 live-1440.png --after-1440 preview-1440.png \\",
    "    --before-390 live-390.png --after-390 preview-390.png \\",
    '    --shot drawer-open.png:"Cart drawer open, 390"',
    "```",
    "",
    "## The ticket",
    "",
    buildAgentBrief(detail),
  ].join("\n");
}
