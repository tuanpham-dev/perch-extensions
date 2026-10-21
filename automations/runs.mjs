// What a run leaves behind and when an event may start one, as pure functions
// of the store's document - no timers, no sockets - so every rule is pinned by
// src/runs.test.ts.
//
// Loop prevention. Every task an automation creates is remembered in the
// document's `origins`, keyed by task id: { automationId, depth, at }. A task
// made by a schedule, Run now or an event from a task no automation made has
// depth 1; a task made because of an event from a depth-d task has depth
// d + 1. An event from a task an automation made never starts that same
// automation again, and an event from a depth-3 task starts nothing at all:
// the run is recorded as "stopped" with a note instead, so a chain of
// automations feeding each other ends after three hops.

export const MAX_CHAIN_DEPTH = 3;
export const RUN_HISTORY = 20;
// Plenty for any chain still in flight; the oldest are forgotten first.
export const ORIGIN_MAX = 500;
export const CHAIN_STOP_NOTE = `stopped: chain depth ${MAX_CHAIN_DEPTH} reached`;

// The depth of a task created by a run that `origin` (the triggering task's
// record, or null/undefined) started.
export function childDepth(origin) {
  const depth = Number(origin?.depth);
  return (Number.isInteger(depth) && depth > 0 ? depth : 0) + 1;
}

// What happens when an event matching `automation`'s trigger arrives:
//   "paused"  Pause All is on - nothing fires, nothing is recorded;
//   "own"     the event's task came from this automation - ignored;
//   "depth"   the chain is too deep - recorded as stopped, not run;
//   "run"     run it.
export function eventDecision(automation, origin, { paused = false } = {}) {
  if (paused) return "paused";
  if (origin?.automationId && origin.automationId === automation.id) return "own";
  if (childDepth(origin) > MAX_CHAIN_DEPTH) return "depth";
  return "run";
}

// Adds one run to the front of `entry.runs`, keeping the newest RUN_HISTORY,
// and mirrors it onto the entry's last* fields the panel and older documents
// read. An entry saved before the history existed gets its one last result
// carried in as the first item. `counted` false (a missed or stopped run)
// leaves runCount alone. Mutates and returns `entry`.
export function pushRun(entry, run, { counted = true, max = RUN_HISTORY } = {}) {
  if (!Array.isArray(entry.runs)) {
    entry.runs = entry.lastRunAt || entry.lastStatus
      ? [{ at: entry.lastRunAt ?? null, status: entry.lastStatus ?? null, reason: entry.lastReason ?? "", result: entry.lastResult ?? "" }]
      : [];
  }
  entry.runs.unshift(run);
  if (entry.runs.length > max) entry.runs.length = max;
  entry.lastRunAt = run.at;
  entry.lastResult = run.result;
  entry.lastStatus = run.status;
  entry.lastReason = run.reason;
  if (counted) entry.runCount = (entry.runCount ?? 0) + 1;
  return entry;
}

// Remembers which automation made `taskId` and how deep in a chain it sits,
// forgetting the oldest records past `max`. Mutates and returns `origins`.
export function rememberOrigin(origins, taskId, { automationId, depth, at = Date.now() }, max = ORIGIN_MAX) {
  origins[taskId] = { automationId, depth, at };
  const ids = Object.keys(origins);
  if (ids.length > max) {
    ids.sort((a, b) => (origins[a].at ?? 0) - (origins[b].at ?? 0));
    for (const id of ids.slice(0, ids.length - max)) delete origins[id];
  }
  return origins;
}
