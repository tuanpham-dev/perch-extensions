// Whether any AI agent is working, and how long ago the last one finished,
// from core's agent hooks (host.agentHooks). A turn starts at prompt-submit
// and ends at stop. A permission prompt counts as the end too: the agent is
// waiting for a person, and whoever answers it is at the keyboard, which
// keeps the computer awake on its own.

// A turn with no stop for this long is taken as over: the agent was killed
// mid-turn, or its terminal closed unseen, and no stop will ever come.
export const STALE_MS = 6 * 60 * 60 * 1000;

// How long after the last agent finishes "Agent" keeps the computer awake.
export const AFTER_AGENTS_MS = 30 * 60 * 1000;

export const EVENTS = ["prompt-submit", "permission", "stop"];

export function createActivity() {
  // Window id ($PERCH_WINDOW) -> the turn under way there.
  const working = new Map();
  let lastEndedAt = null;

  return {
    onEvent(event) {
      if (!event.paneId) return;
      if (event.event === "prompt-submit") {
        // `ours`: the window was one of Perch's when the turn started, so its
        // closing ends the turn.
        working.set(event.paneId, { startedAt: event.receivedAt, ours: event.sessionName !== null });
      } else if (event.event === "stop" || event.event === "permission") {
        working.delete(event.paneId);
        lastEndedAt = event.receivedAt;
      }
    },

    // `openWindows`: the ids of the terminal windows that exist now, or null
    // when they couldn't be read (then only staleness ends a turn).
    read(now, openWindows) {
      for (const [id, turn] of working) {
        const over = now - turn.startedAt > STALE_MS || (turn.ours && openWindows !== null && !openWindows.has(id));
        if (over) {
          working.delete(id);
          lastEndedAt = Math.max(lastEndedAt ?? 0, Math.min(now, turn.startedAt + STALE_MS));
        }
      }
      return {
        working: working.size,
        // A duration, so a viewer whose clock differs from the server's
        // still reads it right. Null when nothing has ended yet, or while an
        // agent works.
        idleForMs: working.size > 0 || lastEndedAt === null ? null : Math.max(0, now - lastEndedAt),
      };
    },
  };
}

// Whether a mode wants the computer awake, given what agents are doing.
export function wantsAwake(mode, activity) {
  if (mode === "on") return true;
  if (mode !== "agent") return false;
  return activity.working > 0 || (activity.idleForMs !== null && activity.idleForMs < AFTER_AGENTS_MS);
}
