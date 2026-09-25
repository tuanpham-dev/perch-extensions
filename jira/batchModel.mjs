// The batch state machine, as functions over one store document. No terminal
// backend, no filesystem, no clock of its own (every "now" is a parameter and
// every id is passed in), so every rule here is pinned by calling it - see
// src/batchModel.test.ts, laid out the way agent-tasks' src/model.test.ts is.
//
// The document (batchStore.mjs owns reading and writing it):
//
//   { version: 1, batches: { [id]: Batch } }
//
// A Batch holds the tickets it was planned from, the clusters they were split
// into, and one state per ticket that is being worked. A cluster is one git
// worktree with one long-lived agent in it; a ticket's state is what that
// agent has reported about it.
//
// Two kinds of function live here, and the difference matters:
//   queries   take a document or a batch and return something. Pure.
//   mutators  take a DRAFT batch (inside batchStore's update()) and change it
//             in place, returning { ok, error } where a rule can refuse.
// Nothing here ever reads the clock or invents an id: the caller passes both,
// so a test can pin a transition to the millisecond.
//
// Why a ticket's state IS stored, unlike agent-tasks' task status which is
// computed: a ticket's state is a report from an agent ("I finished this"),
// not a function of the document. There is nothing to derive it from.
// A CLUSTER's state is partly derived - see clusterState - because "waiting"
// and "idle" ARE functions of its tickets.

export const TICKET_STATES = ["queued", "in-progress", "needs-you", "review", "rework", "done", "failed"];
export const CLUSTER_STATES = ["pending", "running", "waiting", "idle", "stopped", "closed"];

// The cluster states that may take more tickets. A stopped or closed cluster
// has no agent to hand them to, so "Add to batch" never offers one.
export const OPEN_FOR_ADD = new Set(["pending", "running", "waiting", "idle"]);

// Ticket states that still want something from the agent. Used for "is this
// cluster idle" and for the queue a resumed worker is told about.
const UNFINISHED = new Set(["queued", "in-progress", "needs-you", "rework"]);

// What the sidebar badge counts: work that is back with YOU, either because
// the agent is blocked or because it finished and wants a look.
const NEEDS_ATTENTION = new Set(["needs-you", "review"]);

// A cluster whose stored state is one of these has a worktree and (once) a
// window; the ones before it never started.
const STARTED = new Set(["running", "waiting", "idle", "stopped", "closed"]);

export const CLUSTER_ACTIONS = ["start", "open", "stop", "resume", "close", "remove-worktree"];

// How many colors the board cycles through for cluster chips. The client owns
// what each one looks like; the model only keeps the index stable so a
// cluster's color does not change under the user when another is added.
export const CLUSTER_COLORS = 8;

const MAX_NOTES = 50;

export function emptyDocument() {
  return { version: 1, batches: {} };
}

// Tolerant: a hand-edited or partially written document still loads, with
// anything missing defaulted rather than the whole file thrown away. A batch
// that survives normalization is one every function below can be called on.
export function normalizeDocument(raw) {
  const doc = emptyDocument();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return doc;
  const batches = raw.batches;
  if (!batches || typeof batches !== "object" || Array.isArray(batches)) return doc;
  for (const [id, value] of Object.entries(batches)) {
    const batch = normalizeBatch(id, value);
    if (batch) doc.batches[id] = batch;
  }
  return doc;
}

function normalizeBatch(id, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const clusters = Array.isArray(raw.clusters) ? raw.clusters.filter(isObject).map(normalizeCluster) : [];
  const tickets = isObject(raw.tickets) ? raw.tickets : {};
  const rawStates = isObject(raw.ticketStates) ? raw.ticketStates : {};
  const ticketStates = {};
  for (const [key, value] of Object.entries(rawStates)) {
    const state = normalizeTicketState(value);
    if (state) ticketStates[key] = state;
  }
  return {
    id,
    name: str(raw.name) || "Batch",
    repo: str(raw.repo),
    createdAt: num(raw.createdAt),
    updatedAt: num(raw.updatedAt),
    archivedAt: typeof raw.archivedAt === "number" ? raw.archivedAt : null,
    criteria: str(raw.criteria),
    readCodebase: raw.readCodebase === true,
    agentId: str(raw.agentId),
    tickets,
    clusters,
    ticketStates,
    unclustered: Array.isArray(raw.unclustered) ? raw.unclustered.filter((k) => typeof k === "string") : [],
    pendingProposal: isObject(raw.pendingProposal) ? raw.pendingProposal : null,
  };
}

function normalizeCluster(raw) {
  return {
    id: str(raw.id),
    name: str(raw.name) || "Cluster",
    rationale: str(raw.rationale),
    files: Array.isArray(raw.files) ? raw.files.filter((f) => typeof f === "string") : [],
    color: Number.isInteger(raw.color) ? raw.color : 0,
    keys: Array.isArray(raw.keys) ? raw.keys.filter((k) => typeof k === "string") : [],
    branch: str(raw.branch),
    worktreePath: str(raw.worktreePath),
    worktreeRemovedAt: typeof raw.worktreeRemovedAt === "number" ? raw.worktreeRemovedAt : null,
    sessionName: str(raw.sessionName),
    windowId: str(raw.windowId),
    agentId: str(raw.agentId),
    state: CLUSTER_STATES.includes(raw.state) ? raw.state : "pending",
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
    stoppedReason: str(raw.stoppedReason),
    lastError: str(raw.lastError),
    lastEventAt: typeof raw.lastEventAt === "number" ? raw.lastEventAt : null,
    // What the agent is blocked on with no ticket of its own in flight - a
    // permission prompt before the first `jira-batch start`, say. A ticket in
    // needs-you covers the common case; this covers the rest, so a cluster
    // waiting on you is never drawn as if it were working.
    awaiting: str(raw.awaiting) || null,
    notes: Array.isArray(raw.notes) ? raw.notes.slice(-MAX_NOTES) : [],
    // What this cluster actually started with, so a report can be traced to
    // the procedure that produced it even after the setting changes. Null in
    // a slot means the agent's own judgement.
    skills: normalizeSkills(raw.skills),
    // Where its assembled qa-report spec and rendered HTML ended up.
    qaSpecPath: str(raw.qaSpecPath),
    qaReportPath: str(raw.qaReportPath),
  };
}

function normalizeSkillRecord(raw) {
  if (!isObject(raw)) return null;
  return {
    name: str(raw.name),
    dir: str(raw.dir),
    origin: str(raw.origin),
    missing: raw.missing === true,
    wanted: str(raw.wanted),
  };
}

function normalizeSkills(raw) {
  if (!isObject(raw)) return { execution: null, qa: null, execFallback: false };
  return {
    execution: normalizeSkillRecord(raw.execution),
    qa: normalizeSkillRecord(raw.qa),
    execFallback: raw.execFallback === true,
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value) {
  return typeof value === "string" ? value : "";
}

function num(value) {
  return typeof value === "number" ? value : 0;
}

// ---- Creating ----

export function newTicket(row) {
  return {
    key: row.key,
    summary: str(row.summary),
    type: str(row.type),
    priority: str(row.priority),
    url: str(row.url),
    projectKey: str(row.projectKey),
  };
}

export function newBatch({ id, name, repo, criteria, readCodebase, tickets, now }) {
  return {
    id,
    name: name || "Batch",
    repo,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    criteria: str(criteria),
    readCodebase: readCodebase === true,
    agentId: "",
    tickets: Object.fromEntries(tickets.map((row) => [row.key, newTicket(row)])),
    clusters: [],
    ticketStates: {},
    unclustered: tickets.map((row) => row.key),
    pendingProposal: null,
  };
}

export function newCluster({ id, name, rationale = "", files = [], color, keys = [] }) {
  return {
    id,
    name: name || "Cluster",
    rationale: str(rationale),
    files: files.slice(0, 20),
    color,
    keys: [...keys],
    branch: "",
    worktreePath: "",
    worktreeRemovedAt: null,
    sessionName: "",
    windowId: "",
    agentId: "",
    state: "pending",
    startedAt: null,
    stoppedReason: "",
    lastError: "",
    lastEventAt: null,
    awaiting: null,
    notes: [],
    skills: { execution: null, qa: null, execFallback: false },
    qaSpecPath: "",
    qaReportPath: "",
  };
}

function newTicketState(clusterId, now) {
  return {
    state: "queued",
    clusterId,
    since: now,
    history: [{ state: "queued", at: now, note: "" }],
    summary: "",
    reason: "",
    feedbackDraft: "",
    feedback: [],
    // The QA report, once one is filed. Null until then, which is what the
    // board's "no QA report" mark reads.
    qa: null,
    // Earlier reports for this ticket, newest last. A ticket reworked and
    // re-reported keeps its first verdict rather than overwriting the record
    // of what it looked like before the feedback.
    qaHistory: [],
  };
}

// qa-report's own vocabulary, so a status means the same thing in the panel,
// in the spec and in the rendered HTML. Anything else is recorded as
// unverified rather than refused - a report that arrives is worth keeping.
export const QA_STATUSES = ["pass", "fail", "partial", "blocked"];

function asList(value) {
  if (Array.isArray(value)) return value.map((entry) => str(entry).trim()).filter(Boolean);
  const single = str(value).trim();
  return single ? [single] : [];
}

export function newQaReport(raw, now) {
  const status = QA_STATUSES.includes(raw?.status) ? raw.status : "unverified";
  return {
    status,
    problem: asList(raw?.problem),
    fix: asList(raw?.fix),
    steps: asList(raw?.steps),
    notes: asList(raw?.notes),
    files: asList(raw?.files),
    // Set by the runner once an image has been validated and copied into the
    // store; the model never sees a path from the agent.
    before: raw?.before ? { ext: str(raw.before.ext), at: now } : null,
    after: raw?.after ? { ext: str(raw.after.ext), at: now } : null,
    // The user's own rendered report, referenced where it sits.
    reportPath: str(raw?.reportPath),
    at: now,
  };
}

// A worker filing its QA for one ticket. Refused for a key this cluster does
// not hold, exactly as the other verbs are, and for a ticket that has no
// state yet - there is nothing to attach a report to before a cluster starts.
export function recordQa(batch, clusterId, key, raw, now) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId} in this batch` };
  if (!cluster.keys.includes(key)) {
    return { ok: false, error: `${key} is not in this cluster - it holds ${cluster.keys.join(", ") || "nothing"}` };
  }
  const ticket = batch.ticketStates[key];
  if (!ticket) return { ok: false, error: `${key} has no state yet - this cluster has not started` };

  // A repeat is normal: a ticket sent back for rework is QA'd again, and the
  // reviewer should still be able to see what the first pass claimed.
  if (ticket.qa) {
    ticket.qaHistory = [...(ticket.qaHistory ?? []), ticket.qa].slice(-10);
  }
  ticket.qa = newQaReport(raw, now);

  cluster.awaiting = null;
  cluster.lastEventAt = now;
  batch.updatedAt = now;
  return { ok: true, status: ticket.qa.status };
}

export function normalizeTicketState(raw) {
  if (!isObject(raw)) return null;
  return {
    ...raw,
    qa: isObject(raw.qa) ? raw.qa : null,
    qaHistory: Array.isArray(raw.qaHistory) ? raw.qaHistory.filter(isObject) : [],
  };
}

export function hasQa(ticket) {
  return Boolean(ticket?.qa);
}

// Whether a cluster's report can be assembled: every ticket it holds has
// reached a state nobody is going to change by working. A spec built before
// that would be a snapshot of a run still in progress.
export function specReady(batch, cluster) {
  if (cluster.keys.length === 0) return false;
  return cluster.keys.every((key) => TERMINAL_TICKET_STATES.has(batch.ticketStates[key]?.state));
}

const TERMINAL_TICKET_STATES = new Set(["review", "done", "failed"]);

export function markQaArtifacts(batch, clusterId, { specPath, reportPath }, now) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId}` };
  if (specPath !== undefined) cluster.qaSpecPath = str(specPath);
  if (reportPath !== undefined) cluster.qaReportPath = str(reportPath);
  batch.updatedAt = now;
  return { ok: true };
}

// ---- Lookups ----

export function clusterOf(batch, clusterId) {
  return batch.clusters.find((cluster) => cluster.id === clusterId) ?? null;
}

export function clusterOfKey(batch, key) {
  return batch.clusters.find((cluster) => cluster.keys.includes(key)) ?? null;
}

export function clusterByWindow(batch, windowId) {
  if (!windowId) return null;
  return batch.clusters.find((cluster) => cluster.windowId === windowId) ?? null;
}

export function isStarted(cluster) {
  return STARTED.has(cluster.state);
}

// The ticket a cluster's agent is on, if any. At most one: a worker reports
// `start` for the ticket it is about to work, and the next `start` is only
// legal after the previous one is reported.
export function activeKey(batch, cluster) {
  return (
    cluster.keys.find((key) => {
      const ticket = batch.ticketStates[key];
      return ticket && (ticket.state === "in-progress" || ticket.state === "needs-you");
    }) ?? null
  );
}

// ---- Derived cluster state ----
//
// The stored state says what the RUNNER did (never started, launched, killed,
// closed). These two layers say what the agent is doing, which only the
// tickets know: anything waiting on you wins over "running", and a worker
// with nothing unfinished left is idle rather than still working.
export function clusterState(batch, cluster) {
  if (cluster.state !== "running") return cluster.state;
  const keys = cluster.keys.filter((key) => batch.ticketStates[key]);
  if (cluster.awaiting || keys.some((key) => batch.ticketStates[key].state === "needs-you")) return "waiting";
  if (keys.length > 0 && !keys.some((key) => UNFINISHED.has(batch.ticketStates[key].state))) return "idle";
  return "running";
}

export function allowedClusterActions(batch, cluster) {
  const state = clusterState(batch, cluster);
  const allowed = new Set();
  if (state === "pending") allowed.add("start");
  // Nothing to open before a session exists, and nothing to open once it has
  // been killed - the row would offer a button that could only error.
  if (cluster.sessionName && state !== "closed" && state !== "stopped") allowed.add("open");
  if (state === "running" || state === "waiting" || state === "idle") allowed.add("stop");
  if (state === "stopped") allowed.add("resume");
  if (state === "idle" || state === "stopped") allowed.add("close");
  if (state === "closed" && cluster.worktreePath && !cluster.worktreeRemovedAt) allowed.add("remove-worktree");
  return CLUSTER_ACTIONS.filter((action) => allowed.has(action));
}

// ---- Planning (review-time edits) ----

function nextColor(batch) {
  return batch.clusters.length % CLUSTER_COLORS;
}

// Every key the batch has already committed to a cluster that started. These
// can never be re-placed: the agent has been told about them.
function frozenKeys(batch) {
  const frozen = new Set();
  for (const cluster of batch.clusters) {
    if (!isStarted(cluster)) continue;
    for (const key of cluster.keys) frozen.add(key);
  }
  // A ticket handed to a running cluster has a state even before that cluster
  // is "started" in the stored sense; either way it is spoken for.
  for (const key of Object.keys(batch.ticketStates)) frozen.add(key);
  return frozen;
}

// Lay the AI's (or the heuristic's) proposal over the batch.
//
//   addOnly: false  the planning pass. Every cluster that has not started is
//                   replaced by the proposal; started ones keep their tickets.
//   addOnly: true   "Add to batch". Existing clusters keep their tickets AND
//                   their order; only keys the batch has not placed yet are
//                   put anywhere (spec R27).
//
// Keys the proposal invents, repeats, or tries to move are dropped rather
// than obeyed, and each drop is reported as a warning - a model that returns
// something slightly wrong should cost the user a note, not a mangled batch.
export function applyProposal(batch, proposal, { addOnly = false, makeId, now }) {
  const warnings = [];
  const frozen = frozenKeys(batch);
  const known = new Set(Object.keys(batch.tickets));
  const placed = new Set();
  // What the batch already holds when this proposal arrives, kept apart from
  // what the proposal itself has placed: a key in both is "left where it is",
  // a key twice in the proposal is a model that repeated itself. Checking the
  // reasons in that order is what makes each warning true.
  const held = new Set();
  const seen = new Set();

  const take = (keys, clusterName) => {
    const out = [];
    for (const key of Array.isArray(keys) ? keys : []) {
      if (typeof key !== "string") continue;
      if (!known.has(key)) {
        warnings.push(`${key} is not in this batch - left out of "${clusterName}"`);
        continue;
      }
      if (frozen.has(key)) {
        // Only worth saying in add mode: in a planning pass every frozen key
        // is one the user can see is already running.
        if (addOnly) warnings.push(`${key} is already being worked - left where it is`);
        continue;
      }
      if (held.has(key)) {
        if (addOnly) warnings.push(`${key} is already in this batch - left where it is`);
        continue;
      }
      if (seen.has(key)) {
        warnings.push(`${key} was listed twice - kept in the first cluster that claimed it`);
        continue;
      }
      seen.add(key);
      out.push(key);
      placed.add(key);
    }
    return out;
  };

  const kept = [];
  for (const cluster of batch.clusters) {
    if (addOnly || isStarted(cluster)) {
      kept.push(cluster);
      for (const key of cluster.keys) held.add(key);
    }
  }

  const byId = new Map(kept.map((cluster) => [cluster.id, cluster]));
  const created = [];
  for (const raw of Array.isArray(proposal?.clusters) ? proposal.clusters : []) {
    if (!isObject(raw)) continue;
    const name = str(raw.name).slice(0, 60) || "Cluster";
    const existing = raw.id ? byId.get(raw.id) : null;
    if (raw.id && !existing) {
      warnings.push(`"${name}" named a cluster that is no longer there - added as a new one`);
    }
    const keys = take(raw.keys, name);
    if (existing) {
      if (!OPEN_FOR_ADD.has(clusterState(batch, existing))) {
        if (keys.length > 0) {
          warnings.push(`"${existing.name}" is ${clusterState(batch, existing)} and cannot take more tickets`);
          for (const key of keys) placed.delete(key);
        }
        continue;
      }
      existing.keys.push(...keys);
      // A running cluster keeps the name and reasoning it was launched with;
      // only a cluster still being planned takes the proposal's wording.
      if (!isStarted(existing)) {
        existing.name = name;
        existing.rationale = str(raw.rationale);
        existing.files = Array.isArray(raw.files) ? raw.files.filter((f) => typeof f === "string").slice(0, 20) : [];
      }
      continue;
    }
    if (keys.length === 0 && addOnly) continue;
    created.push(
      newCluster({
        id: makeId(),
        name,
        rationale: str(raw.rationale),
        files: Array.isArray(raw.files) ? raw.files.filter((f) => typeof f === "string") : [],
        color: (kept.length + created.length) % CLUSTER_COLORS,
        keys,
      }),
    );
  }

  batch.clusters = [...kept, ...created];
  batch.unclustered = Object.keys(batch.tickets).filter(
    (key) => !frozen.has(key) && !placed.has(key) && !batch.clusters.some((c) => c.keys.includes(key)),
  );
  batch.updatedAt = now;
  return { placed: [...placed], warnings };
}

// The batch's own name. Derived at creation from its first cluster (see
// server.js), which is a reasonable guess and nothing more - "Cart drawer
// totals +2" says little once the batch has been worked for a day. An empty
// name keeps the old one rather than leaving a row with nothing to click.
export function renameBatch(batch, name, now) {
  // Trimmed before the cap, not after: slicing first turns a long name into
  // one with trailing space, and leaves whitespace-only input looking like a
  // real name until the trim that no longer runs on it.
  const next = str(name).trim().slice(0, 80);
  if (!next) return { ok: false, error: "a batch needs a name" };
  batch.name = next;
  batch.updatedAt = now;
  return { ok: true };
}

export function renameCluster(batch, clusterId, name, now) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId}` };
  // A blank keeps the old name rather than failing, since a cluster always has
  // one to fall back on - but blank has to mean whitespace too, or a name of
  // three spaces passes as real and the column heading goes empty.
  const next = str(name).trim().slice(0, 60);
  if (next) cluster.name = next;
  batch.updatedAt = now;
  return { ok: true };
}

export function addCluster(batch, { id, name, now }) {
  const cluster = newCluster({ id, name: name || `Cluster ${batch.clusters.length + 1}`, color: nextColor(batch) });
  batch.clusters.push(cluster);
  batch.updatedAt = now;
  return { ok: true, cluster };
}

// Deleting a cluster that is only planned sends its tickets back to
// Unclustered rather than out of the batch - the user grouped them for a
// reason, and losing them to a misclick is worse than an extra drag.
export function removeCluster(batch, clusterId, now) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId}` };
  if (isStarted(cluster)) return { ok: false, error: `"${cluster.name}" has already started - close it instead` };
  batch.clusters = batch.clusters.filter((c) => c.id !== clusterId);
  batch.unclustered.push(...cluster.keys.filter((key) => !batch.ticketStates[key]));
  batch.updatedAt = now;
  return { ok: true };
}

export function setBranch(batch, clusterId, branch, now) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId}` };
  if (isStarted(cluster)) return { ok: false, error: `"${cluster.name}" has already started` };
  cluster.branch = str(branch).trim();
  cluster.lastError = "";
  batch.updatedAt = now;
  return { ok: true };
}

// Drag, or "Move to..." on a card. `clusterId` null means Unclustered.
export function moveTicket(batch, key, clusterId, index, now) {
  if (!batch.tickets[key]) return { ok: false, error: `${key} is not in this batch` };
  if (batch.ticketStates[key]) {
    return { ok: false, error: `${key} has already been handed to an agent` };
  }
  const from = clusterOfKey(batch, key);
  if (from && isStarted(from)) return { ok: false, error: `${key} is already being worked` };
  const to = clusterId ? clusterOf(batch, clusterId) : null;
  if (clusterId && !to) return { ok: false, error: `no cluster ${clusterId}` };
  if (to && !OPEN_FOR_ADD.has(clusterState(batch, to))) {
    return { ok: false, error: `"${to.name}" is ${clusterState(batch, to)} and cannot take more tickets` };
  }

  if (from) from.keys = from.keys.filter((k) => k !== key);
  batch.unclustered = batch.unclustered.filter((k) => k !== key);
  if (to) {
    const at = typeof index === "number" ? Math.max(0, Math.min(index, to.keys.length)) : to.keys.length;
    to.keys.splice(at, 0, key);
  } else {
    batch.unclustered.push(key);
  }
  batch.updatedAt = now;
  return { ok: true };
}

// ---- Starting and stopping ----

export function markStarting(batch, clusterId, { branch, agentId, skills, now }) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId}` };
  if (cluster.state !== "pending") return { ok: false, error: `"${cluster.name}" is ${cluster.state}` };
  if (cluster.keys.length === 0) return { ok: false, error: `"${cluster.name}" has no tickets` };
  cluster.branch = str(branch).trim() || cluster.branch;
  cluster.agentId = str(agentId);
  if (skills) cluster.skills = normalizeSkills(skills);
  cluster.lastError = "";
  batch.updatedAt = now;
  return { ok: true, cluster };
}

// Called once the worktree, the session and the window all exist. Every
// ticket in the cluster gets its state here, which is also what makes them
// frozen against re-planning.
export function markRunning(batch, clusterId, { worktreePath, sessionName, windowId, agentId, now }) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId}` };
  cluster.worktreePath = str(worktreePath);
  cluster.sessionName = str(sessionName);
  cluster.windowId = str(windowId);
  if (agentId) cluster.agentId = str(agentId);
  cluster.state = "running";
  cluster.startedAt = now;
  cluster.stoppedReason = "";
  cluster.lastError = "";
  cluster.lastEventAt = now;
  cluster.awaiting = null;
  for (const key of cluster.keys) {
    if (!batch.ticketStates[key]) batch.ticketStates[key] = newTicketState(clusterId, now);
  }
  batch.unclustered = batch.unclustered.filter((key) => !cluster.keys.includes(key));
  batch.updatedAt = now;
  return { ok: true, cluster };
}

export function markStartFailed(batch, clusterId, error, now) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId}` };
  cluster.state = "pending";
  cluster.lastError = str(error);
  batch.updatedAt = now;
  return { ok: true };
}

// Its window is gone: killed by the user, or the machine took the process
// with it. Whatever the agent was mid-way through is nobody's now, so it goes
// back to the queue rather than sitting as "in progress" forever.
export function markStopped(batch, clusterId, reason, now) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId}` };
  if (cluster.state === "closed" || cluster.state === "pending") return { ok: false, error: `"${cluster.name}" is ${cluster.state}` };
  cluster.state = "stopped";
  cluster.stoppedReason = str(reason);
  cluster.windowId = "";
  cluster.awaiting = null;
  for (const key of cluster.keys) {
    const ticket = batch.ticketStates[key];
    if (ticket && (ticket.state === "in-progress" || ticket.state === "needs-you")) {
      setTicketState(ticket, "queued", now, reason);
    }
  }
  batch.updatedAt = now;
  return { ok: true, cluster };
}

export function markClosed(batch, clusterId, now) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId}` };
  cluster.state = "closed";
  cluster.windowId = "";
  cluster.sessionName = cluster.sessionName;
  cluster.awaiting = null;
  batch.updatedAt = now;
  return { ok: true, cluster };
}

export function markWorktreeRemoved(batch, clusterId, now) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId}` };
  cluster.worktreeRemovedAt = now;
  batch.updatedAt = now;
  return { ok: true };
}

// A resumed worker is a new window on the same worktree; its tickets keep
// whatever they had reached.
export function markResumed(batch, clusterId, { sessionName, windowId, now }) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId}` };
  cluster.state = "running";
  cluster.sessionName = str(sessionName) || cluster.sessionName;
  cluster.windowId = str(windowId);
  cluster.stoppedReason = "";
  cluster.lastEventAt = now;
  cluster.awaiting = null;
  batch.updatedAt = now;
  return { ok: true, cluster };
}

// ---- Reports from the worker ----

function setTicketState(ticket, state, now, note = "") {
  ticket.state = state;
  ticket.since = now;
  ticket.history.push({ state, at: now, note: str(note) });
  if (ticket.history.length > 60) ticket.history.splice(0, ticket.history.length - 60);
}

// Which states each verb may act from. `done` and `fail` accept rework
// directly because the feedback message tells the agent to re-report without
// starting again, and needs-you because an agent that was waiting on a
// permission prompt is still working the same ticket.
const REPORT_FROM = {
  start: new Set(["queued", "rework", "in-progress", "needs-you"]),
  done: new Set(["in-progress", "needs-you", "rework"]),
  fail: new Set(["in-progress", "needs-you", "rework", "queued"]),
};

const REPORT_TO = { start: "in-progress", done: "review", fail: "failed" };

// `jira-batch start|done|fail` from the worker's pane. Refusals are messages
// the agent reads in its own terminal, so they say what to do, not what rule
// was broken.
export function ticketReport(batch, clusterId, key, verb, { summary = "", reason = "", now }) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId} in this batch` };
  if (!REPORT_TO[verb]) return { ok: false, error: `unknown report "${verb}"` };
  if (!cluster.keys.includes(key)) {
    return { ok: false, error: `${key} is not in this cluster - it holds ${cluster.keys.join(", ") || "nothing"}` };
  }
  const ticket = batch.ticketStates[key];
  if (!ticket) return { ok: false, error: `${key} has no state yet - this cluster has not started` };
  if (!REPORT_FROM[verb].has(ticket.state)) {
    return { ok: false, error: `${key} is ${ticket.state}, so "${verb}" does not apply to it` };
  }

  // Seeing any report is proof the agent is alive and unblocked.
  cluster.awaiting = null;
  cluster.lastEventAt = now;

  if (verb === "start" && (ticket.state === "in-progress" || ticket.state === "needs-you")) {
    // Re-announcing the ticket it is already on: not an error, and not a
    // second history row either.
    if (ticket.state === "needs-you") setTicketState(ticket, "in-progress", now, "the agent carried on");
    batch.updatedAt = now;
    return { ok: true, state: ticket.state };
  }

  if (verb === "done") ticket.summary = str(summary);
  if (verb === "fail") ticket.reason = str(reason);
  setTicketState(ticket, REPORT_TO[verb], now, verb === "fail" ? str(reason) : str(summary));
  batch.updatedAt = now;
  return { ok: true, state: ticket.state };
}

export function addNote(batch, clusterId, text, now) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId} in this batch` };
  cluster.notes.push({ text: str(text), at: now });
  if (cluster.notes.length > MAX_NOTES) cluster.notes.splice(0, cluster.notes.length - MAX_NOTES);
  cluster.awaiting = null;
  cluster.lastEventAt = now;
  batch.updatedAt = now;
  return { ok: true };
}

// ---- Agent hook events ----
//
// Core delivers these for the WINDOW an agent runs in, which is why a cluster
// is keyed on its window id: a session can be renamed, a window renumbered,
// and the id survives both. Only the four events subscribed to arrive here.
export function hookEvent(batch, windowId, event, now) {
  const cluster = clusterByWindow(batch, windowId);
  if (!cluster || cluster.state !== "running") return { ok: false, error: "no running cluster for that window" };
  const key = activeKey(batch, cluster);
  const ticket = key ? batch.ticketStates[key] : null;

  if (event === "permission" || event === "stop") {
    const note = event === "permission" ? "waiting on a permission prompt" : "the turn ended without a report";
    // A stop after everything is reported is just the agent going quiet at
    // its prompt, which is exactly what the brief asks of it - not a wait.
    if (!ticket) {
      if (event === "permission") cluster.awaiting = note;
      else if (hasUnfinished(batch, cluster)) cluster.awaiting = note;
    } else if (ticket.state !== "needs-you") {
      setTicketState(ticket, "needs-you", now, note);
    }
  } else if (event === "prompt-submit") {
    cluster.awaiting = null;
    if (ticket && ticket.state === "needs-you") setTicketState(ticket, "in-progress", now, "the agent carried on");
  }
  cluster.lastEventAt = now;
  batch.updatedAt = now;
  return { ok: true };
}

function hasUnfinished(batch, cluster) {
  return cluster.keys.some((key) => {
    const ticket = batch.ticketStates[key];
    return ticket && UNFINISHED.has(ticket.state);
  });
}

// Any sign of life from the worker's own commands.
export function clusterSeen(batch, clusterId, now) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId}` };
  cluster.lastEventAt = now;
  cluster.awaiting = null;
  batch.updatedAt = now;
  return { ok: true };
}

// ---- Review and feedback ----

export function setFeedbackDraft(batch, key, text, now) {
  const ticket = batch.ticketStates[key];
  if (!ticket) return { ok: false, error: `${key} is not being worked` };
  ticket.feedbackDraft = str(text);
  batch.updatedAt = now;
  return { ok: true };
}

// The drafts waiting to go out, grouped by the cluster whose agent will get
// them - one message per cluster, because each send is a separate prompt.
export function sendableFeedback(batch) {
  const groups = [];
  for (const cluster of batch.clusters) {
    const items = cluster.keys
      .filter((key) => batch.ticketStates[key]?.feedbackDraft.trim())
      .map((key) => ({
        key,
        summary: batch.tickets[key]?.summary ?? "",
        feedback: batch.ticketStates[key].feedbackDraft.trim(),
      }));
    if (items.length > 0) groups.push({ clusterId: cluster.id, clusterName: cluster.name, items });
  }
  return groups;
}

export function pendingFeedbackCount(batch) {
  return sendableFeedback(batch).reduce((total, group) => total + group.items.length, 0);
}

export function markFeedbackSent(batch, clusterId, keys, now) {
  const cluster = clusterOf(batch, clusterId);
  if (!cluster) return { ok: false, error: `no cluster ${clusterId}` };
  for (const key of keys) {
    const ticket = batch.ticketStates[key];
    if (!ticket) continue;
    const text = ticket.feedbackDraft.trim();
    if (!text) continue;
    ticket.feedback.push({ text, sentAt: now });
    ticket.feedbackDraft = "";
    setTicketState(ticket, "rework", now, text);
  }
  cluster.lastEventAt = now;
  batch.updatedAt = now;
  return { ok: true };
}

// Accepting is the reviewer's own verdict, so it is allowed from failed too:
// "the agent could not do it, and that is fine" is a real outcome.
export function accept(batch, key, now) {
  const ticket = batch.ticketStates[key];
  if (!ticket) return { ok: false, error: `${key} is not being worked` };
  if (ticket.state !== "review" && ticket.state !== "failed") {
    return { ok: false, error: `${key} is ${ticket.state} - only a reviewed or failed ticket can be accepted` };
  }
  setTicketState(ticket, "done", now, "accepted");
  batch.updatedAt = now;
  return { ok: true };
}

// ---- Batch-level rules ----

export function canArchive(batch) {
  return batch.clusters.every((cluster) => {
    const state = clusterState(batch, cluster);
    return state === "closed" || state === "pending";
  });
}

export function canDelete(batch) {
  return canArchive(batch);
}

export function badgeCount(doc) {
  let count = 0;
  for (const batch of Object.values(doc.batches)) {
    if (batch.archivedAt) continue;
    for (const ticket of Object.values(batch.ticketStates)) {
      if (NEEDS_ATTENTION.has(ticket.state)) count += 1;
    }
  }
  return count;
}

export function ticketCounts(batch) {
  const counts = Object.fromEntries(TICKET_STATES.map((state) => [state, 0]));
  for (const key of Object.keys(batch.tickets)) {
    const ticket = batch.ticketStates[key];
    counts[ticket ? ticket.state : "queued"] += 1;
  }
  return counts;
}

// What a resumed worker is told about: everything it has not finished, in the
// cluster's own order.
export function remainingTickets(batch, cluster) {
  return cluster.keys
    .filter((key) => UNFINISHED.has(batch.ticketStates[key]?.state))
    .map((key) => ({
      key,
      summary: batch.tickets[key]?.summary ?? "",
      state: batch.ticketStates[key].state,
    }));
}

// Which batches changed between two documents, for the SSE stream. Compared
// by value rather than by an updatedAt every mutator would have to remember
// to bump: a missed bump is a board that silently stops updating, and a batch
// document is small enough that this costs nothing.
export function diffEvents(before, after) {
  const ids = new Set([...Object.keys(before?.batches ?? {}), ...Object.keys(after?.batches ?? {})]);
  const events = [];
  for (const id of ids) {
    const a = before?.batches?.[id];
    const b = after?.batches?.[id];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) events.push({ batchId: id });
  }
  return events;
}
