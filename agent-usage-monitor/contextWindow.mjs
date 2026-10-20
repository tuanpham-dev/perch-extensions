// How many tokens a model's context window holds. Claude's transcripts don't
// record it, and neither the transcript's model id nor ~/.claude/sessions
// says whether a session runs with 1M context (checked against Claude Code
// 2.1.296), so it comes from here: a per-model override from the
// agentUsage.contextWindows setting first, then 1M for an id that names a 1M
// variant or a turn that already sent more than 200k (only a 1M window takes
// that), then 200k, the window every other current Claude model has.

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const LONG_CONTEXT_WINDOW = 1_000_000;

// The setting is a JSON object of model id -> tokens. Anything else (unset,
// malformed, non-positive numbers) contributes nothing.
export function parseOverrides(raw) {
  if (typeof raw !== "string" || !raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out = {};
  for (const [model, tokens] of Object.entries(parsed)) {
    if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) out[model] = Math.round(tokens);
  }
  return out;
}

export function windowFor(model, overrides = {}, contextTokens = 0) {
  if (typeof model === "string" && overrides[model]) return overrides[model];
  if (typeof model === "string" && /\[1m\]|-1m\b/i.test(model)) return LONG_CONTEXT_WINDOW;
  if (typeof contextTokens === "number" && contextTokens > DEFAULT_CONTEXT_WINDOW) return LONG_CONTEXT_WINDOW;
  return DEFAULT_CONTEXT_WINDOW;
}
