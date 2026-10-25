// keep-awake server hook: keeps the computer this Perch server runs on from
// going to sleep - always ("on"), or while an AI agent is working and for 30
// minutes after the last one finishes ("agent"). The machine that matters is
// the one running the agents, which is this one: with the desktop app's
// Local server it's the computer in front of you, with a remote server it's
// that machine.
//
// GET /state is what the status bar item shows; PUT /mode changes it. The
// mode is one setting per server, kept in this extension's storage so it
// survives restarts.
import { hostname } from "node:os";
import { createActivity, EVENTS, wantsAwake } from "./activity.mjs";
import { takeHold } from "./hold.mjs";

const MODES = ["on", "agent", "off"];
// How often the decision is made again without anything happening (the 30
// minutes after the last agent running out).
const TICK_MS = 30_000;

let timer = null;
let hold = null;
let stopped = false;

export function activate({ router, host, storage }) {
  stopped = false;
  const settings = storage.collection("settings");
  const activity = createActivity();
  let mode = "off";
  let error = null;
  let note = null;
  // One decision at a time: taking a hold waits on a helper process.
  let deciding = Promise.resolve();

  const openWindows = async () => {
    try {
      const sessions = await host.sessions.list();
      return new Set(sessions.flatMap((s) => s.windows.map((w) => w.id)));
    } catch {
      return null;
    }
  };

  const read = async () => activity.read(Date.now(), await openWindows());

  const decide = () => {
    deciding = deciding.then(async () => {
      if (stopped) return;
      const want = wantsAwake(mode, await read());
      if (want && !hold) {
        try {
          const taken = await takeHold();
          if (stopped) {
            taken.release();
            return;
          }
          hold = taken;
          note = taken.note;
          error = null;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      } else if (!want && hold) {
        hold.release();
        hold = null;
        note = null;
        error = null;
      } else if (!want) {
        error = null;
      }
    });
    return deciding;
  };

  host.agentHooks.subscribe({
    events: EVENTS,
    onEvent(event) {
      activity.onEvent(event);
      void decide();
    },
  });

  settings
    .get("mode")
    .then((stored) => {
      if (MODES.includes(stored?.value)) mode = stored.value;
    })
    .catch(() => {})
    .finally(() => void decide());
  timer = setInterval(() => void decide(), TICK_MS);

  const state = async () => ({
    mode,
    active: hold !== null,
    error,
    note,
    hostname: hostname(),
    ...(await read()),
  });

  router.get("/state", async (_req, res) => {
    await deciding;
    res.json(await state());
  });

  router.put("/mode", async (req, res) => {
    const next = req.body?.mode;
    if (!MODES.includes(next)) {
      res.status(400).json({ error: `mode must be one of ${MODES.join(", ")}` });
      return;
    }
    mode = next;
    await settings.put("mode", next);
    await decide();
    res.json(await state());
  });
}

export function deactivate() {
  stopped = true;
  clearInterval(timer);
  timer = null;
  hold?.release();
  hold = null;
}
