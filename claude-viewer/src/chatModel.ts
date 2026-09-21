// The conversation as the tab renders it, built incrementally from transcript
// messages. Ported from the claude-web extension's chatModel.ts, extended with
// what a terminal session writes that a chat UI should show differently:
// slash commands and their output, `!` shell commands, and compaction
// boundaries. Harness-injected text (command caveats, system reminders) is
// dropped, since the terminal never shows it either.

export type ContentBlock = { type: string; [key: string]: unknown };

export type ChatItem =
  | { kind: "text"; role: "user" | "assistant"; text: string; key: string }
  | { kind: "image"; dataUri: string; key: string }
  | { kind: "thinking"; text: string; key: string }
  | { kind: "tool"; toolId: string; key: string }
  | { kind: "command"; command: string; args: string; key: string }
  | { kind: "output"; text: string; error: boolean; key: string }
  | { kind: "compact"; trigger: string; preTokens: number | null; postTokens: number | null; summary: string | null; key: string };

export type ToolCard = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: { content: unknown; isError: boolean };
  structuredResult?: unknown;
  children: ChatItem[];
};

export type ChatModel = { items: ChatItem[]; tools: Record<string, ToolCard> };

export type TranscriptMessage = {
  type: string;
  uuid?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { role?: string; content?: unknown; id?: string; model?: string; usage?: unknown };
  toolUseResult?: unknown;
  parent_tool_use_id?: string | null;
  trigger?: string;
  preTokens?: number | null;
  postTokens?: number | null;
};

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
function userText(list: ChatItem[], raw: string): void {
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
  if (text) list.push({ kind: "text", role: "user", text, key: nextKey() });
}

function pushBlocks(model: ChatModel, role: "user" | "assistant", content: unknown, parent: string | null | undefined, structured: unknown) {
  const list = targetList(model, parent);
  const blocks: ContentBlock[] =
    typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as ContentBlock[]) : [];
  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        const text = String(block.text ?? "");
        if (text.trim() === "") break;
        if (role === "user") userText(list, text);
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
        model.tools[id] = { id, name: String(block.name ?? "tool"), input: (block.input as Record<string, unknown>) ?? {}, children: [] };
        list.push({ kind: "tool", toolId: id, key: nextKey() });
        break;
      }
      case "tool_result": {
        const card = model.tools[String(block.tool_use_id ?? "")];
        if (card) {
          card.result = { content: block.content, isError: Boolean(block.is_error) };
          if (structured !== undefined) card.structuredResult = structured;
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
    if (m.type !== "user" && m.type !== "assistant") continue;
    if (!m.message) continue;
    if (m.isCompactSummary) {
      const last = [...model.items].reverse().find((i) => i.kind === "compact");
      const content = m.message.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b: ContentBlock) => (b.type === "text" ? String(b.text ?? "") : "")).join("\n") : "";
      if (last && last.kind === "compact") last.summary = text;
      continue;
    }
    if (m.isMeta && m.type === "user") continue;
    pushBlocks(model, m.type, m.message.content, m.parent_tool_use_id, m.toolUseResult);
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
