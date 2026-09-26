// A ticket's review: a code review of its pull request and a visual QA of its
// preview theme, each worked by an agent and reported through `jira-review`.
//
// Pure state, the same bargain batchModel.mjs makes: every function takes the
// document (or a piece of it) and a clock, changes it in place, and answers
// { ok, error }. The runner does the side effects; this decides what they are
// allowed to do. Plain ESM beside server.js so the client can share the menu
// logic (reviewModel.d.mts types the part it uses).
//
// One review per ticket, keyed by its key. It outlives its worktree: closing a
// review removes the checkout and keeps the reports, which is the whole point
// of copying the screenshots into the extension's own store.

export const TASKS = ["code", "qa"];
export const ACTIONS = ["code", "qa", "both"];
export const VERDICTS = ["approve", "request-changes", "comment"];
export const SEVERITIES = ["high", "medium", "low"];
export const QA_STATUSES = ["pass", "fail", "partial", "blocked"];
// The four captures every checked page gets: the live storefront and the
// preview theme, each on a desktop and a phone.
export const PAGE_SHOTS = ["before-1440", "after-1440", "before-390", "after-390"];

const TASK_STATES = ["running", "reported", "stopped", "failed"];
const MAX_FINDINGS = 60;
const MAX_TEXT = 2000;
const MAX_PAGES = 12;
export const MAX_EXTRA_SHOTS = 8;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value, max = MAX_TEXT) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function lines(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
  return list.map((item) => str(item)).filter(Boolean).slice(0, 40);
}

// ---- The document ----

export function emptyDocument() {
  return { version: 1, reviews: {}, repoPaths: {} };
}

function normalizeImage(raw) {
  return isObject(raw) && ["png", "jpg", "webp"].includes(raw.ext) ? { ext: raw.ext } : null;
}

function normalizeCodeReport(raw) {
  if (!isObject(raw)) return null;
  return {
    verdict: VERDICTS.includes(raw.verdict) ? raw.verdict : "comment",
    summary: str(raw.summary),
    findings: (Array.isArray(raw.findings) ? raw.findings : [])
      .filter(isObject)
      .slice(0, MAX_FINDINGS)
      .map((f) => ({
        severity: SEVERITIES.includes(f.severity) ? f.severity : "low",
        file: str(f.file, 300),
        line: num(f.line),
        text: str(f.text),
      }))
      .filter((f) => f.text),
    at: num(raw.at) ?? 0,
  };
}

function normalizePage(raw) {
  const images = {};
  for (const which of PAGE_SHOTS) images[which] = normalizeImage(raw?.images?.[which]);
  return {
    page: str(raw?.page, 300) || "/",
    slug: str(raw?.slug, 80) || "page",
    images,
    extras: (Array.isArray(raw?.extras) ? raw.extras : [])
      .filter(isObject)
      .slice(0, MAX_EXTRA_SHOTS)
      .map((e) => ({ label: str(e.label, 20), caption: str(e.caption, 120), ...(normalizeImage(e) ?? { ext: "png" }) }))
      .filter((e) => /^shot-\d+$/.test(e.label)),
  };
}

function normalizeQaReport(raw) {
  if (!isObject(raw)) return null;
  return {
    status: QA_STATUSES.includes(raw.status) ? raw.status : "blocked",
    checked: lines(raw.checked),
    wrong: lines(raw.wrong),
    notes: lines(raw.notes),
    pages: (Array.isArray(raw.pages) ? raw.pages : []).filter(isObject).slice(0, MAX_PAGES).map(normalizePage),
    at: num(raw.at) ?? 0,
  };
}

function normalizeTask(raw, name) {
  if (!isObject(raw)) return null;
  const report = name === "code" ? normalizeCodeReport(raw.report) : normalizeQaReport(raw.report);
  return {
    state: TASK_STATES.includes(raw.state) ? raw.state : "failed",
    windowId: str(raw.windowId, 100),
    agentId: str(raw.agentId, 200),
    cwd: str(raw.cwd, 1000),
    startedAt: num(raw.startedAt) ?? 0,
    endedAt: num(raw.endedAt),
    error: str(raw.error),
    report,
  };
}

function normalizeReview(key, raw) {
  if (!isObject(raw)) return null;
  const tasks = isObject(raw.tasks) ? raw.tasks : {};
  const posted = isObject(raw.posted) ? raw.posted : {};
  return {
    key,
    repo: str(raw.repo, 1000),
    worktreePath: str(raw.worktreePath, 1000),
    branch: str(raw.branch, 300),
    sessionName: str(raw.sessionName, 200),
    prUrl: str(raw.prUrl, 500),
    previewUrl: str(raw.previewUrl, 2000),
    tasks: { code: normalizeTask(tasks.code, "code"), qa: normalizeTask(tasks.qa, "qa") },
    posted: {
      pr: isObject(posted.pr) ? { url: str(posted.pr.url, 500), at: num(posted.pr.at) ?? 0 } : null,
      jira: isObject(posted.jira) ? { at: num(posted.jira.at) ?? 0 } : null,
    },
    createdAt: num(raw.createdAt) ?? 0,
    updatedAt: num(raw.updatedAt) ?? 0,
  };
}

// Tolerant, like batchModel's: a half-written or hand-edited document loads
// with what it can, and a task that was running when the server went away is
// read as it was - the runner's sweep decides whether its window survived.
export function normalizeDocument(raw) {
  const doc = emptyDocument();
  if (!isObject(raw)) return doc;
  for (const [key, value] of Object.entries(isObject(raw.reviews) ? raw.reviews : {})) {
    const review = normalizeReview(key, value);
    if (review) doc.reviews[key] = review;
  }
  for (const [repo, value] of Object.entries(isObject(raw.repoPaths) ? raw.repoPaths : {})) {
    if (typeof value === "string" && value) doc.repoPaths[repo] = value;
  }
  return doc;
}

// ---- The menu ----

// Which of the three the ticket's links allow. Both needs both: with one kind
// of link it would run exactly what the other item already does.
export function enabledActions(links) {
  const code = (links?.prs?.length ?? 0) > 0;
  const qa = (links?.previews?.length ?? 0) > 0;
  return { code, qa, both: code && qa };
}

// What the button's main part runs: the remembered choice when this ticket
// allows it, otherwise the first item the menu would offer. Null when the
// ticket has no link at all, which is also when the button is not shown.
export function effectiveAction(links, saved) {
  const enabled = enabledActions(links);
  if (ACTIONS.includes(saved) && enabled[saved]) return saved;
  return ACTIONS.find((action) => enabled[action]) ?? null;
}

export function tasksFor(action) {
  return action === "both" ? ["code", "qa"] : action === "code" || action === "qa" ? [action] : [];
}

// ---- Running ----

export function reviewOf(doc, key) {
  return doc.reviews[key] ?? null;
}

// The record is written before anything is made, so a failure part way leaves
// a task that says so rather than a worktree nobody can see.
export function startTask(doc, key, task, { agentId = "", cwd = "", prUrl, previewUrl, repo }, now) {
  if (!TASKS.includes(task)) return { ok: false, error: `unknown task "${task}"` };
  let review = doc.reviews[key];
  if (!review) {
    review = normalizeReview(key, { createdAt: now, updatedAt: now });
    doc.reviews[key] = review;
  }
  if (review.tasks[task]?.state === "running") {
    return { ok: false, error: `the ${task === "code" ? "code review" : "visual QA"} of ${key} is already running` };
  }
  if (prUrl !== undefined) review.prUrl = str(prUrl, 500);
  if (previewUrl !== undefined) review.previewUrl = str(previewUrl, 2000);
  if (repo !== undefined) review.repo = str(repo, 1000);
  // Run again replaces the report: an older verdict beside a newer run would
  // be evidence for the wrong pass. What was posted stays posted.
  review.tasks[task] = {
    state: "running",
    windowId: "",
    agentId: str(agentId, 200),
    cwd: str(cwd, 1000),
    startedAt: now,
    endedAt: null,
    error: "",
    report: null,
  };
  review.updatedAt = now;
  return { ok: true, review };
}

export function setWorkspace(doc, key, { worktreePath, branch, sessionName }, now) {
  const review = doc.reviews[key];
  if (!review) return { ok: false, error: `no review of ${key}` };
  if (worktreePath !== undefined) review.worktreePath = str(worktreePath, 1000);
  if (branch !== undefined) review.branch = str(branch, 300);
  if (sessionName !== undefined) review.sessionName = str(sessionName, 200);
  review.updatedAt = now;
  return { ok: true };
}

export function setTaskWindow(doc, key, task, { windowId, cwd }, now) {
  const current = doc.reviews[key]?.tasks?.[task];
  if (!current) return { ok: false, error: `no ${task} task on ${key}` };
  if (windowId !== undefined) current.windowId = str(windowId, 100);
  if (cwd !== undefined) current.cwd = str(cwd, 1000);
  doc.reviews[key].updatedAt = now;
  return { ok: true };
}

function runningTask(doc, key, task) {
  const review = doc.reviews[key];
  if (!review) return { error: `no review of ${key}` };
  const current = review.tasks[task];
  if (!current) return { error: `${key} has no ${task} task - start it from the ticket` };
  if (current.state !== "running") {
    return { error: `the ${task} task of ${key} is ${current.state}, not running - start it again from the ticket` };
  }
  return { review, current };
}

export function recordCodeReport(doc, key, raw, now) {
  const { review, current, error } = runningTask(doc, key, "code");
  if (error) return { ok: false, error };
  if (!VERDICTS.includes(raw?.verdict)) return { ok: false, error: `--verdict must be one of ${VERDICTS.join(", ")}` };
  if (!str(raw?.summary).trim()) return { ok: false, error: "--summary is required" };
  current.report = normalizeCodeReport({ ...raw, at: now });
  current.state = "reported";
  current.endedAt = now;
  review.updatedAt = now;
  return { ok: true, verdict: current.report.verdict, findings: current.report.findings.length };
}

export function recordQaReport(doc, key, raw, now) {
  const { review, current, error } = runningTask(doc, key, "qa");
  if (error) return { ok: false, error };
  if (!QA_STATUSES.includes(raw?.status)) return { ok: false, error: `--status must be one of ${QA_STATUSES.join(", ")}` };
  current.report = normalizeQaReport({ ...raw, at: now });
  current.state = "reported";
  current.endedAt = now;
  review.updatedAt = now;
  return { ok: true, status: current.report.status, pages: current.report.pages.length };
}

function endTask(doc, key, task, state, error, now) {
  const current = doc.reviews[key]?.tasks?.[task];
  if (!current) return { ok: false, error: `no ${task} task on ${key}` };
  if (current.state !== "running") return { ok: true, unchanged: true };
  current.state = state;
  current.error = str(error);
  current.endedAt = now;
  current.windowId = "";
  doc.reviews[key].updatedAt = now;
  return { ok: true };
}

export function markTaskFailed(doc, key, task, error, now) {
  return endTask(doc, key, task, "failed", error, now);
}

export function markTaskStopped(doc, key, task, now) {
  return endTask(doc, key, task, "stopped", "", now);
}

export function isRunning(review) {
  return TASKS.some((task) => review?.tasks?.[task]?.state === "running");
}

// Removing the checkout is the runner's; this refuses while an agent still
// works in it and forgets where it was once it is gone.
export function closeReview(doc, key, now) {
  const review = doc.reviews[key];
  if (!review) return { ok: false, error: `no review of ${key}` };
  if (isRunning(review)) return { ok: false, error: `stop the running ${TASKS.filter((t) => review.tasks[t]?.state === "running").join(" and ")} first` };
  review.worktreePath = "";
  review.branch = "";
  review.sessionName = "";
  for (const task of TASKS) if (review.tasks[task]) review.tasks[task].windowId = "";
  review.updatedAt = now;
  return { ok: true };
}

export function setPosted(doc, key, which, info, now) {
  const review = doc.reviews[key];
  if (!review) return { ok: false, error: `no review of ${key}` };
  if (which === "pr") review.posted.pr = { url: str(info?.url, 500), at: now };
  else if (which === "jira") review.posted.jira = { at: now };
  else return { ok: false, error: `unknown post "${which}"` };
  review.updatedAt = now;
  return { ok: true };
}

export function rememberRepoPath(doc, repoName, repoPath) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repoName)) return { ok: false, error: `not an owner/repo: ${repoName}` };
  doc.repoPaths[repoName.toLowerCase()] = repoPath;
  return { ok: true };
}

// ---- Page names ----

// A page path becomes part of a filename, so it is reduced to a slug here
// rather than trusted: "/" is home, "/products/pod?x=1" is products-pod.
export function pageSlug(page, taken = new Set()) {
  const pathOnly = String(page ?? "").split(/[?#]/)[0];
  const base =
    pathOnly
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "home";
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

// ---- What gets posted ----

const VERDICT_TEXT = { approve: "Approved", "request-changes": "Changes requested", comment: "Comments" };
const QA_TEXT = { pass: "Pass", fail: "Fail", partial: "Partial", blocked: "Blocked" };

export function prReviewFlag(verdict) {
  return verdict === "approve" ? "--approve" : verdict === "request-changes" ? "--request-changes" : "--comment";
}

function findingLine(f) {
  const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\` ` : "";
  return `- **${f.severity}** ${where}${f.text}`;
}

// One PR review: the summary, then the findings, most severe first. Markdown,
// since GitHub renders it.
export function buildPrReviewBody(review) {
  const report = review?.tasks?.code?.report;
  if (!report) return "";
  const order = (f) => SEVERITIES.indexOf(f.severity);
  const findings = [...report.findings].sort((a, b) => order(a) - order(b));
  const out = [report.summary.trim()];
  if (findings.length > 0) out.push("", "### Findings", ...findings.map(findingLine));
  out.push("", `_Reviewed for ${review.key} from Perch._`);
  return out.join("\n");
}

// One Jira comment covering whatever has reported. Plain lines, because the
// comment helper turns each line into an ADF paragraph.
export function buildJiraComment(review, perchUrl = "") {
  const out = [];
  const code = review?.tasks?.code?.report;
  const qa = review?.tasks?.qa?.report;
  if (code) {
    out.push(`Code review: ${VERDICT_TEXT[code.verdict]}${review.prUrl ? ` (${review.prUrl})` : ""}`);
    out.push(code.summary.trim());
    const serious = code.findings.filter((f) => f.severity !== "low");
    for (const f of serious) out.push(`- ${f.severity}: ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} - ` : ""}${f.text}`);
    if (code.findings.length > serious.length) out.push(`- and ${code.findings.length - serious.length} minor`);
  }
  if (qa) {
    if (out.length > 0) out.push("");
    out.push(`Visual QA: ${QA_TEXT[qa.status]}${review.previewUrl ? ` (${review.previewUrl})` : ""}`);
    if (qa.checked.length > 0) out.push(`Checked: ${qa.checked.join("; ")}`);
    for (const item of qa.wrong) out.push(`- ${item}`);
    for (const note of qa.notes) out.push(note);
  }
  if (perchUrl) out.push("", `Screenshots and details: ${perchUrl}`);
  return out.join("\n").trim();
}

// Which reviews changed between two documents, for the SSE stream - by value,
// for the same reason batchModel's diffEvents gives.
export function diffEvents(before, after) {
  const keys = new Set([...Object.keys(before?.reviews ?? {}), ...Object.keys(after?.reviews ?? {})]);
  const events = [];
  for (const key of keys) {
    if (JSON.stringify(before?.reviews?.[key] ?? null) !== JSON.stringify(after?.reviews?.[key] ?? null)) events.push({ key });
  }
  return events;
}
