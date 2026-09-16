// Server hook for the ai-command extension: POST /generate asks the app's
// shared AI backend (ctx.ai — configured once in Settings → AI Providers, see the
// host's server/src/ai.ts) for one shell command; POST /type inserts text
// into the session's current window through the host session API, which works
// on whichever terminal backend runs it. The generated command is only ever
// RETURNED and inserted at the prompt — nothing here executes it.
//
// This extension used to carry its own provider table and its own
// provider/binaryPath/model/customCommand settings, duplicated from prompts.
// Both moved into core: which AI to use is one decision, not one per
// extension, so all this contributes now is the prompt.
const MAX_QUERY_LENGTH = 1000;
const MAX_TEXT_LENGTH = 4096;

// Strips markdown code fences and a leading "$ " if the model added them
// despite the prompt, then keeps the LAST non-empty line: a well-behaved
// reply is one line either way, and a chatty provider (session banners,
// reasoning preamble) puts the answer at the end, not the start.
function extractCommand(reply) {
  const unfenced = reply.replace(/^```[a-z]*\n?/gim, "").replace(/```/g, "");
  const lines = unfenced.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim().replace(/^\$\s+/, "");
    if (trimmed) return trimmed;
  }
  return "";
}

export function activate({ router, getSettings, ai, host }) {
  router.post("/generate", async (req, res) => {
    const { query, cwd } = req.body ?? {};
    if (typeof query !== "string" || !query.trim()) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    if (query.length > MAX_QUERY_LENGTH) {
      res.status(400).json({ error: "query too long" });
      return;
    }

    const prompt =
      "Convert this request into exactly one shell command for a POSIX shell on Linux. " +
      "Reply with ONLY the command itself - no prose, no explanation, no code fences, no leading $.\n" +
      (typeof cwd === "string" && cwd ? `Current directory: ${cwd}\n` : "") +
      `Request: ${query.trim()}`;

    try {
      // aiCommand.aiProfile names one of the AIs configured in Settings →
      // AI; empty (the default) lets the app's default profile answer.
      const settings = (await getSettings?.()) ?? {};
      const profileId =
        typeof settings["aiCommand.aiProfile"] === "string" ? settings["aiCommand.aiProfile"].trim() : "";
      // Empty falls back to that profile's own model — "use the provider's
      // setting" — which is what ai.run does with no model of its own.
      const model =
        typeof settings["aiCommand.aiModel"] === "string" ? settings["aiCommand.aiModel"].trim() : "";
      const command = extractCommand(
        await ai.run(prompt, { ...(profileId ? { profileId } : {}), ...(model ? { model } : {}) }),
      );
      if (!command) {
        res.status(502).json({ error: "the AI returned no usable command" });
        return;
      }
      res.json({ command });
    } catch (err) {
      // ai.run's AiError codes separate "not configured yet" from "the
      // provider broke"; the first reads better as guidance than as a 502.
      const code = err?.code;
      const configIssue =
        code === "missing-binary" || code === "missing-key" || code === "missing-model" || code === "missing-command";
      res.status(configIssue ? 400 : 502).json({ error: String(err?.message ?? err) });
    }
  });

  router.post("/type", async (req, res) => {
    const { session, text, submit } = req.body ?? {};
    if (typeof session !== "string" || !session || typeof text !== "string" || !text) {
      res.status(400).json({ error: "session and text are required" });
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ error: "text too long" });
      return;
    }
    try {
      // AI-generated commands are never auto-run, but the route keeps the
      // flag for parity with its siblings — the client never sends true.
      await host.sessions.sendText(session, text, submit === true);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
