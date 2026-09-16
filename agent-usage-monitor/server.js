// Serves what the readers find, and nothing else: this extension never
// writes to an agent's files, never sends keys to a pane, and keeps no state
// beyond a short cache.
//
//   GET /usage                      every agent that has readable usage
//   GET /model?session=&window=       the agent and model in one terminal
//
// A reader whose agent isn't installed drops out at available(), so a
// machine with only one agent does only that agent's work. Which window runs
// which agent is core's answer (host.agents.forWindow), not this
// extension's: matching command names and walking /proc here got the tmux
// case right and the bundled-daemon case wrong.
import * as claude from "./readers/claude.mjs";
import * as codex from "./readers/codex.mjs";

const READERS = [claude, codex];

// The usage payload is polled by three status-bar items and the popover, so
// it is cached; the underlying files change on the order of seconds anyway.
const USAGE_CACHE_TTL_MS = 5_000;
const DEFAULT_BLOCK_HOURS = 5;

let usageCache = null; // { at, blockMs, payload }
let availableCache = null; // { at, readers }
const AVAILABLE_TTL_MS = 30_000;

async function availableReaders() {
  const now = Date.now();
  if (availableCache && now - availableCache.at < AVAILABLE_TTL_MS) return availableCache.readers;
  const flags = await Promise.all(
    READERS.map(async (reader) => {
      try {
        return await reader.available();
      } catch {
        return false;
      }
    }),
  );
  const readers = READERS.filter((_, i) => flags[i]);
  availableCache = { at: now, readers };
  return readers;
}

function blockMsFrom(getSettings) {
  const hours = Number(getSettings?.()?.["agentUsage.blockHours"]);
  const safe = Number.isFinite(hours) && hours >= 1 && hours <= 24 ? hours : DEFAULT_BLOCK_HOURS;
  return safe * 60 * 60 * 1000;
}

// One agent's slice of the payload. A reader that throws contributes a note
// instead of failing the whole request: one unreadable agent must not cost
// the user the other one's numbers.
// Each agent brings its own mark (core resolves it to a URL); matching on
// the registry program is what ties a reader to the agent it reads for.
async function agentIcons(host) {
  try {
    const agents = (await host.agents?.list?.()) ?? [];
    return new Map(agents.map((a) => [a.program, { iconUrl: a.iconUrl ?? "", icon: a.icon ?? "" }]));
  } catch {
    return new Map();
  }
}

async function agentUsage(reader, now, blockMs) {
  try {
    const { blocks, limits, spend, notes, plan } = await reader.usage({ now, blockMs });
    return {
      id: reader.id,
      label: reader.label,
      blocks: blocks ?? [],
      limits: limits ?? [],
      spend: spend ?? { supported: false },
      notes: notes ?? [],
      plan: plan ?? null,
    };
  } catch (err) {
    return {
      id: reader.id,
      label: reader.label,
      blocks: [],
      limits: [],
      spend: { supported: false },
      notes: [`couldn't read ${reader.label} usage: ${err.message}`],
      plan: null,
    };
  }
}

export function activate({ router, getSettings, log, host }) {
  router.get("/usage", async (req, res) => {
    try {
      const now = Date.now();
      const blockMs = blockMsFrom(getSettings);
      if (usageCache && usageCache.blockMs === blockMs && now - usageCache.at < USAGE_CACHE_TTL_MS) {
        res.json(usageCache.payload);
        return;
      }
      const readers = await availableReaders();
      const [agents, icons] = await Promise.all([
        Promise.all(readers.map((reader) => agentUsage(reader, now, blockMs))),
        agentIcons(host),
      ]);
      for (const agent of agents) {
        const mark = icons.get(READERS.find((r) => r.id === agent.id)?.program);
        agent.iconUrl = mark?.iconUrl ?? "";
        agent.icon = mark?.icon ?? "";
      }
      // An agent with a reader but nothing recorded yet is left out, so the
      // popover never shows an empty section for an agent nobody uses.
      const payload = {
        agents: agents.filter((a) => a.blocks.length > 0 || a.limits.length > 0 || a.notes.length > 0),
      };
      usageCache = { at: now, blockMs, payload };
      res.json(payload);
    } catch (err) {
      log("usage error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Which agent (if any) runs in one terminal, and on which model. Core
  // answers the first half through host.agents.forWindow — matching the
  // window's command and its process tree, whichever terminal backend runs
  // it — so this only has to turn an agent process into the model it is
  // using, from that agent's own files.
  router.get("/model", async (req, res) => {
    const session = typeof req.query.session === "string" ? req.query.session : "";
    const windowIndex = Number(req.query.window);
    if (!session || !Number.isFinite(windowIndex)) {
      res.json({});
      return;
    }
    try {
      const window = await host.agents?.forWindow?.(session, windowIndex);
      if (!window) {
        res.json({});
        return;
      }
      const reader = READERS.find((r) => window.program === r.program);
      if (!reader) {
        res.json({});
        return;
      }
      let model = null;
      try {
        model = await reader.modelFor({ pid: window.agentPid, cwd: window.cwd });
      } catch (err) {
        log(`${reader.id} model lookup failed:`, err.message);
      }
      res.json(model ? { agentId: reader.id, label: reader.label, model } : {});
    } catch {
      // A window that closed between render and request is ordinary.
      res.json({});
    }
  });
}
