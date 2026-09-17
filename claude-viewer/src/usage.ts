// Context and cost from the transcript's own usage fields. Claude Code writes
// one transcript line per content block of an assistant message, each carrying
// the same message id and the same usage, so every figure here is counted once
// per message id.
//
// Prices are Anthropic first-party API rates per million tokens (cached from
// the Claude API reference on 2026-09-16). Cache writes are 1.25x input and
// cache reads 0.1x input unless a model lists its own read rate. A subscription
// plan is not billed per token, so the toolbar labels this an estimate.

export type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type Price = { input: number; output: number; cacheRead?: number; window: number };

const PRICES: [RegExp, Price][] = [
  [/^claude-(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25, window: 1_000_000 }],
  [/^claude-(fable|mythos)-5/, { input: 10, output: 50, window: 1_000_000 }],
  [/^claude-opus-(5|4-8|4-7|4-6)/, { input: 5, output: 25, window: 1_000_000 }],
  [/^claude-sonnet-5/, { input: 2, output: 10, window: 1_000_000 }],
  [/^claude-sonnet-4-6/, { input: 3, output: 15, window: 1_000_000 }],
  [/^claude-haiku-4-5/, { input: 1, output: 5, window: 200_000 }],
];

export function priceFor(model: string | null | undefined): Price | null {
  if (!model) return null;
  const id = model.replace(/\[1m\]$/i, "");
  for (const [re, price] of PRICES) if (re.test(id)) return price;
  return null;
}

export function contextWindowFor(model: string | null | undefined): number | null {
  if (!model) return null;
  if (/\[1m\]$|-1m$/i.test(model)) return 1_000_000;
  return priceFor(model)?.window ?? null;
}

export function contextTokens(usage: Usage): number {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

export function costOf(model: string | null | undefined, usage: Usage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const read = p.cacheRead ?? p.input * 0.1;
  return (
    ((usage.input_tokens ?? 0) * p.input +
      (usage.cache_creation_input_tokens ?? 0) * p.input * 1.25 +
      (usage.cache_read_input_tokens ?? 0) * read +
      (usage.output_tokens ?? 0) * p.output) /
    1_000_000
  );
}

// Running totals over transcript messages, fed incrementally as the tab
// tails the transcript.
export type UsageTally = {
  seen: Set<string>;
  cost: number;
  unpriced: number;
  model: string | null;
  // The model name Claude reported after a /model switch ("Sonnet 5"), until
  // an assistant message from the new model arrives.
  switchedTo: string | null;
  context: number | null;
};

export function createTally(): UsageTally {
  return { seen: new Set(), cost: 0, unpriced: 0, model: null, switchedTo: null, context: null };
}

// A model id as the toolbar shows it: without the vendor prefix or a release
// date ("claude-haiku-4-5-20251001" reads "haiku-4-5"). Same rule as Agent
// Usage Monitor's status bar item.
export function modelLabel(modelId: string | null | undefined): string {
  if (typeof modelId !== "string" || !modelId.trim()) return "";
  let name = modelId.trim();
  for (const prefix of ["claude-", "anthropic/", "anthropic."]) {
    if (name.toLowerCase().startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  name = name.replace(/-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, "");
  return name || modelId.trim();
}

// "Set model to Sonnet 5 for this session only" -> "Sonnet 5".
export function modelFromCommandOutput(text: string): string | null {
  const m = /Set model to (.+?)(?: and saved as your default| for this session| \(|$)/m.exec(text);
  return m ? m[1].trim() : null;
}

export function currentModelLabel(tally: UsageTally): string {
  return tally.switchedTo ?? modelLabel(tally.model);
}

type TranscriptEntry = {
  type?: string;
  parent_tool_use_id?: string | null;
  message?: { id?: string; model?: string; usage?: Usage; content?: unknown };
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: { type?: string; text?: string }) => (b?.type === "text" ? (b.text ?? "") : "")).join("\n");
  return "";
}

export function addToTally(tally: UsageTally, entries: TranscriptEntry[]): void {
  for (const e of entries) {
    if (e?.type === "compact_boundary") {
      tally.context = null;
      continue;
    }
    if (e?.type === "user" && !e.parent_tool_use_id) {
      const out = textOf(e.message?.content);
      if (out.includes("<local-command-stdout>")) {
        const switched = modelFromCommandOutput(out.replace(/<[^>]+>/g, ""));
        if (switched) tally.switchedTo = switched;
      }
      continue;
    }
    if (e?.type !== "assistant") continue;
    const m = e.message;
    if (!m?.usage || !m.id || m.model === "<synthetic>") continue;
    if (!e.parent_tool_use_id) {
      if (m.model && m.model !== tally.model) tally.switchedTo = null;
      tally.model = m.model ?? tally.model;
      tally.context = contextTokens(m.usage);
    }
    if (tally.seen.has(m.id)) continue;
    tally.seen.add(m.id);
    const c = costOf(m.model, m.usage);
    if (c === null) tally.unpriced++;
    else tally.cost += c;
  }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
