// The conversation as the tab renders it, built incrementally from transcript
// messages. Ported from the claude-web extension's chatModel.ts, extended with
// what a terminal session writes that a chat UI should show differently:
// slash commands and their output, `!` shell commands, and compaction
// boundaries. Harness-injected text (command caveats, system reminders) is
// dropped, since the terminal never shows it either.

export type ContentBlock = { type: string; [key: string]: unknown };

export type ChatItem =
  // `pending`: the tab's own copy of a message it just sent, shown until the
  // transcript catches up (see pending.ts). Never built from a transcript
  // message.
  | { kind: "text"; role: "user" | "assistant"; text: string; queued?: boolean; pending?: boolean; key: string }
  | { kind: "image"; dataUri: string; key: string }
  | { kind: "thinking"; text: string; key: string }
  | { kind: "tool"; toolId: string; key: string }
  | { kind: "command"; command: string; args: string; key: string }
  | { kind: "output"; text: string; error: boolean; key: string }
  | { kind: "compact"; trigger: string; preTokens: number | null; postTokens: number | null; summary: string | null; key: string }
  // Where a subagent's finish notification arrived: one line, not the
  // notification's text (see transcript.mjs's taskNotificationOf).
  | { kind: "agentNote"; toolId: string; key: string };

// How a subagent's run ended, as its task-notification says.
export type AgentNotification = {
  status: string | null;
  result: string | null;
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
  at: number | null;
};

// What is known about the subagent an Agent (or Task) call started, filled in
// as its transcript and notifications arrive.
export type AgentRecord = {
  agentId: string | null;
  type: string | null;
  description: string | null;
  // Launched in the background: the call returned at once, and only a
  // task-notification says when the agent actually finished.
  async: boolean;
  firstAt: number | null;
  lastAt: number | null;
  model: string | null;
  // Claude Code's token figure for an agent: its latest context plus output.
  usageTokens: number | null;
  notification: AgentNotification | null;
};

export type AgentStatus = "running" | "done" | "failed" | "stopped";

export type ToolCard = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: { content: unknown; isError: boolean };
  structuredResult?: unknown;
  children: ChatItem[];
  // The tool call whose children this card is among, or null for the main
  // conversation.
  parent: string | null;
  agent?: AgentRecord;
};

export type ChatModel = { items: ChatItem[]; tools: Record<string, ToolCard> };

export type TranscriptMessage = {
  type: string;
  uuid?: string;
  timestamp?: string | null;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { role?: string; content?: unknown; id?: string; model?: string; usage?: unknown };
  toolUseResult?: unknown;
  parent_tool_use_id?: string | null;
  // Set by the server for a message sent while Claude was already working
  // (transcript.mjs's queuedHumanMessage) - shown with a marker, since it
  // lands mid-turn rather than between turns.
  queued?: boolean;
  trigger?: string;
  preTokens?: number | null;
  postTokens?: number | null;
  // type "task_notification" (transcript.mjs's taskNotificationOf).
  toolUseId?: string | null;
  status?: string | null;
  result?: string | null;
  tokens?: number | null;
  toolUses?: number | null;
  durationMs?: number | null;
};

// A linked subagent's meta, as /transcript returns it.
export type AgentMeta = { toolUseId: string; agentId: string; agentType: string | null; description: string | null };

export const isAgentTool = (name: string) => name === "Agent" || name === "Task";

export function createChatModel(): ChatModel {
  return { items: [], tools: {} };
}

let keyCounter = 0;
const nextKey = () => `k${++keyCounter}`;

function targetList(model: ChatModel, parent: string | null | undefined): ChatItem[] {
  if (parent && model.tools[parent]) return model.tools[parent].children;
  return model.items;
}

const TAG = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`);

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// Removes the ANSI color codes command output often carries.
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

// A user text block, read the way the terminal presents it. Null means show
// nothing.
function userText(list: ChatItem[], raw: string, queued?: boolean): void {
  if (/^<local-command-caveat>/.test(raw.trim())) return;
  const name = TAG("command-name").exec(raw);
  if (name) {
    const args = TAG("command-args").exec(raw)?.[1] ?? "";
    list.push({ kind: "command", command: name[1].trim(), args: unescapeXml(args.trim()), key: nextKey() });
    return;
  }
  const stdout = TAG("local-command-stdout").exec(raw);
  const stderr = TAG("local-command-stderr").exec(raw);
  if (stdout || stderr) {
    const text = stripAnsi(unescapeXml((stdout?.[1] ?? "") + (stderr?.[1] ?? ""))).trim();
    if (text) list.push({ kind: "output", text, error: Boolean(stderr?.[1]?.trim()), key: nextKey() });
    return;
  }
  const bashInput = TAG("bash-input").exec(raw);
  if (bashInput) {
    list.push({ kind: "command", command: "!", args: unescapeXml(bashInput[1].trim()), key: nextKey() });
    return;
  }
  const bashOut = TAG("bash-stdout").exec(raw);
  const bashErr = TAG("bash-stderr").exec(raw);
  if (bashOut || bashErr) {
    const text = stripAnsi(unescapeXml([bashOut?.[1], bashErr?.[1]].filter(Boolean).join("\n"))).trim();
    if (text) list.push({ kind: "output", text, error: Boolean(bashErr?.[1]?.trim()), key: nextKey() });
    return;
  }
  // "[Image #2]" is Claude Code's inline placeholder for an attached image,
  // which renders here as the image itself. A <pasted_content> block is what
  // Claude Code makes of anything pasted into the terminal (and of what this
  // tab itself used to send): the person wrote the text, so show the text.
  const text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<pasted_content id="([0-9a-f]{4})">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g, "$2")
    .replace(/\[Image #\d+\]\s*/g, "")
    .trim();
  if (text) list.push({ kind: "text", role: "user", text, queued, key: nextKey() });
}

function pushBlocks(model: ChatModel, role: "user" | "assistant", content: unknown, parent: string | null | undefined, structured: unknown, queued?: boolean) {
  const list = targetList(model, parent);
  const blocks: ContentBlock[] =
    typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as ContentBlock[]) : [];
  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        const text = String(block.text ?? "");
        if (text.trim() === "") break;
        if (role === "user") userText(list, text, queued);
        else list.push({ kind: "text", role, text, key: nextKey() });
        break;
      }
      case "image": {
        const source = block.source as { type?: string; media_type?: string; data?: string } | undefined;
        if (source?.type === "base64" && source.media_type && source.data) {
          list.push({ kind: "image", dataUri: `data:${source.media_type};base64,${source.data}`, key: nextKey() });
        }
        break;
      }
      case "thinking": {
        const text = String(block.thinking ?? "");
        if (text.trim() !== "") list.push({ kind: "thinking", text, key: nextKey() });
        break;
      }
      case "tool_use": {
        const id = String(block.id ?? nextKey());
        if (model.tools[id]) break;
        const name = String(block.name ?? "tool");
        const input = (block.input as Record<string, unknown>) ?? {};
        const card: ToolCard = { id, name, input, children: [], parent: parent && model.tools[parent] ? parent : null };
        if (isAgentTool(name)) {
          card.agent = {
            agentId: null,
            type: typeof input.subagent_type === "string" ? input.subagent_type : null,
            description: typeof input.description === "string" ? input.description : null,
            async: false,
            firstAt: null,
            lastAt: null,
            model: null,
            usageTokens: null,
            notification: null,
          };
        }
        model.tools[id] = card;
        list.push({ kind: "tool", toolId: id, key: nextKey() });
        break;
      }
      case "tool_result": {
        const card = model.tools[String(block.tool_use_id ?? "")];
        if (card) {
          card.result = { content: block.content, isError: Boolean(block.is_error) };
          if (structured !== undefined) card.structuredResult = structured;
          const launch = structured as { status?: unknown; agentId?: unknown } | undefined;
          if (card.agent && launch && typeof launch === "object") {
            if (launch.status === "async_launched") card.agent.async = true;
            if (typeof launch.agentId === "string") card.agent.agentId ??= launch.agentId;
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

export function applyMessages(model: ChatModel, messages: TranscriptMessage[]): void {
  for (const m of messages) {
    if (m.type === "compact_boundary") {
      model.items.push({
        kind: "compact",
        trigger: m.trigger ?? "auto",
        preTokens: m.preTokens ?? null,
        postTokens: m.postTokens ?? null,
        summary: null,
        key: nextKey(),
      });
      continue;
    }
    if (m.type === "task_notification") {
      applyNotification(model, m);
      continue;
    }
    if (m.type !== "user" && m.type !== "assistant") continue;
    if (!m.message) continue;
    noteAgentActivity(model, m);
    if (m.isCompactSummary) {
      const last = [...model.items].reverse().find((i) => i.kind === "compact");
      const content = m.message.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b: ContentBlock) => (b.type === "text" ? String(b.text ?? "") : "")).join("\n") : "";
      if (last && last.kind === "compact") last.summary = text;
      continue;
    }
    if (m.isMeta && m.type === "user") continue;
    pushBlocks(model, m.type, m.message.content, m.parent_tool_use_id, m.toolUseResult, m.queued);
  }
}

// Base64 image blocks in a tool result, as data URIs.
export function resultImages(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return (content as { type?: string; source?: { media_type?: string; data?: string } }[])
    .filter((b) => b?.type === "image" && typeof b.source?.data === "string")
    .map((b) => `data:${b.source?.media_type ?? "image/png"};base64,${b.source?.data}`);
}

// Every image in the conversation, in the order it appears: attached images,
// tool results (screenshots, images Claude read) and those inside subagent
// traces. What the lightbox steps through.
export function collectImages(model: ChatModel): string[] {
  const out: string[] = [];
  const walk = (items: ChatItem[]) => {
    for (const item of items) {
      if (item.kind === "image") out.push(item.dataUri);
      else if (item.kind === "tool") {
        const card = model.tools[item.toolId];
        if (!card) continue;
        walk(card.children);
        if (card.result) out.push(...resultImages(card.result.content));
      }
    }
  };
  walk(model.items);
  return out;
}

// ---- Subagents ----

function timeOf(m: { timestamp?: string | null }): number | null {
  const t = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
}

// A subagent's own message: when it was active, which model it runs on, and
// its latest token figure.
function noteAgentActivity(model: ChatModel, m: TranscriptMessage): void {
  const agent = m.parent_tool_use_id ? model.tools[m.parent_tool_use_id]?.agent : undefined;
  if (!agent) return;
  const at = timeOf(m);
  if (at !== null) {
    agent.firstAt = agent.firstAt === null ? at : Math.min(agent.firstAt, at);
    agent.lastAt = agent.lastAt === null ? at : Math.max(agent.lastAt, at);
  }
  if (m.type !== "assistant" || !m.message) return;
  if (typeof m.message.model === "string" && !m.message.model.startsWith("<")) agent.model = m.message.model;
  const u = m.message.usage as Record<string, unknown> | undefined;
  if (u && typeof u === "object") {
    const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
    agent.usageTokens = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens") + n("output_tokens");
  }
}

// A notification for an Agent call becomes its record's ending and one line
// where it arrived. One for anything else (a background shell command) has
// no card to belong to and shows nothing, as it never did in the terminal.
function applyNotification(model: ChatModel, m: TranscriptMessage): void {
  const card = m.toolUseId ? model.tools[m.toolUseId] : undefined;
  if (!card?.agent) return;
  card.agent.notification = {
    status: m.status ?? null,
    result: m.result ?? null,
    tokens: m.tokens ?? null,
    toolUses: m.toolUses ?? null,
    durationMs: m.durationMs ?? null,
    at: timeOf(m),
  };
  targetList(model, card.parent).push({ kind: "agentNote", toolId: card.id, key: nextKey() });
}

export function applyAgentMeta(model: ChatModel, agents: AgentMeta[] | undefined): void {
  for (const meta of agents ?? []) {
    const agent = model.tools[meta.toolUseId]?.agent;
    if (!agent) continue;
    agent.agentId = meta.agentId;
    if (meta.agentType) agent.type = meta.agentType;
    if (meta.description) agent.description = meta.description;
  }
}

// Running until the call has a result - or, for one launched in the
// background, until its notification. A background agent that writes again
// after its latest notification was resumed, and is running again.
export function agentStatus(card: ToolCard): AgentStatus {
  const agent = card.agent;
  const n = agent?.notification;
  if (agent && n) {
    if (agent.lastAt !== null && n.at !== null && agent.lastAt > n.at) return "running";
    return n.status === "completed" ? "done" : n.status === "failed" ? "failed" : "stopped";
  }
  if (agent?.async || !card.result) return "running";
  return card.result.isError ? "failed" : "done";
}

export type AgentStats = { elapsedMs: number | null; steps: number; tokens: number | null; model: string | null };

// Claude Code's own totals once an agent has finished; counted from its
// transcript while it runs.
export function agentStats(card: ToolCard, now: number): AgentStats {
  const agent = card.agent;
  const running = agentStatus(card) === "running";
  const n = running ? null : (agent?.notification ?? null);
  const counted = card.children.filter((i) => i.kind === "tool").length;
  let elapsedMs: number | null = null;
  if (n?.durationMs != null) elapsedMs = n.durationMs;
  else if (agent?.firstAt != null) {
    const end = running ? now : (agent.lastAt ?? n?.at ?? now);
    elapsedMs = Math.max(0, end - agent.firstAt);
  }
  return {
    elapsedMs,
    steps: n?.toolUses ?? counted,
    tokens: n?.tokens ?? agent?.usageTokens ?? null,
    model: agent?.model ?? null,
  };
}

// Every subagent that has a transcript here, in the order they started, with
// how deep it is (0: started by the main agent).
export function listAgents(model: ChatModel): { toolId: string; depth: number }[] {
  const out: { toolId: string; depth: number }[] = [];
  const walk = (items: ChatItem[], depth: number) => {
    for (const item of items) {
      if (item.kind !== "tool") continue;
      const card = model.tools[item.toolId];
      if (!card?.agent) continue;
      if (card.children.length > 0 || card.agent.agentId) out.push({ toolId: card.id, depth });
      walk(card.children, depth + 1);
    }
  };
  walk(model.items, 0);
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .filter((b) => b?.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n");
}

// The agent's report: its notification's, or a foreground call's result.
// Never a background launch's result, which is only launch metadata.
export function agentReport(card: ToolCard): string | null {
  const n = card.agent?.notification;
  if (n?.result) return n.result;
  if (card.agent?.async || !card.result) return null;
  const structured = card.structuredResult as { content?: unknown } | undefined;
  const text = textOf(structured && typeof structured === "object" && structured.content !== undefined ? structured.content : card.result.content).trim();
  return text || null;
}
