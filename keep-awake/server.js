// keep-awake server hook: tells the client whether an AI agent is working
// and how long ago the last one finished, for its "Agent" mode. The keeping
// awake itself is the client's, on the device you're looking from: the
// computer running the server is always on already.
import { createActivity, EVENTS } from "./activity.mjs";

export function activate({ router, host }) {
  const activity = createActivity();

  host.agentHooks.subscribe({
    events: EVENTS,
    onEvent(event) {
      activity.onEvent(event);
    },
  });

  const openWindows = async () => {
    try {
      const sessions = await host.sessions.list();
      return new Set(sessions.flatMap((s) => s.windows.map((w) => w.id)));
    } catch {
      return null;
    }
  };

  router.get("/state", async (_req, res) => {
    res.json(activity.read(Date.now(), await openWindows()));
  });
}

export function deactivate() {}
