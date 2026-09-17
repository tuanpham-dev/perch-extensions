// Tool call cards: a collapsed preview per tool that matches what the terminal
// shows (a diff, output lines, a count, a screenshot), expanding to the full
// input and result. Ported from the claude-web extension's ToolCall.tsx, with
// syntax-highlighted diffs and the new chat item kinds.
import { useState } from "react";
import { resultImages as imagesIn, type ChatItem, type ChatModel, type ToolCard } from "./chatModel";
import { useLightbox } from "./Lightbox";
import { langFor, TokenLine, useTokens } from "./Highlight";
import { CommandLine, CommandOutput, CompactDivider, ImageMessage, TextMessage, ThinkingBlock } from "./Message";

function inputSummary(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (name) {
    case "Bash":
      return str("command");
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return str("file_path");
    case "Glob":
    case "Grep":
      return str("pattern");
    case "WebFetch":
      return str("url");
    case "WebSearch":
      return str("query");
    case "Task":
    case "Agent":
      return str("description");
    case "TodoWrite":
      return "update todos";
    default: {
      const first = Object.values(input).find((v) => typeof v === "string");
      return typeof first === "string" ? first : "";
    }
  }
}

function DiffView({
  oldStr,
  newStr,
  maxLines,
  path,
}: {
  oldStr: string;
  newStr: string;
  // Caps total shown lines (old + new), with a "+N more lines" footer.
  maxLines?: number;
  path?: string;
}) {
  const lang = langFor(path);
  const oldTokens = useTokens(oldStr, oldStr ? lang : null);
  const newTokens = useTokens(newStr, lang);
  // A file's final newline is not a line of its own.
  const oldLines = oldStr === "" ? [] : oldStr.replace(/\n$/, "").split("\n");
  const newLines = newStr.replace(/\n$/, "").split("\n");
  const rows = [
    ...oldLines.map((line, i) => ({ key: `o${i}`, cls: "diff-del", sign: "-", text: line, tokens: oldTokens?.[i] })),
    ...newLines.map((line, i) => ({ key: `n${i}`, cls: "diff-add", sign: "+", text: line, tokens: newTokens?.[i] })),
  ];
  const shown = maxLines != null ? rows.slice(0, maxLines) : rows;
  const hidden = rows.length - shown.length;
  return (
    <div className="diff">
      {shown.map((row) => (
        <div key={row.key} className={row.cls}>
          <span className="diff-sign">{row.sign}</span>
          {row.tokens ? <TokenLine tokens={row.tokens} /> : row.text || " "}
        </div>
      ))}
      {hidden > 0 && <div className="tool-preview-more">+{hidden} more lines</div>}
    </div>
  );
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: { type?: string; text?: string }) =>
        block?.type === "text" ? (block.text ?? "") : "",
      )
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content, null, 2);
}

const RESULT_PREVIEW_CHARS = 2500;

function ToolResult({
  card,
  onImageClick,
}: {
  card: ToolCard;
  onImageClick: (src: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!card.result) return <div className="tool-pending">Running</div>;
  const images = imagesIn(card.result?.content);
  const text = resultText(card.result.content);
  const truncated = !expanded && text.length > RESULT_PREVIEW_CHARS;
  return (
    <div className={`tool-result${card.result.isError ? " tool-result-error" : ""}`}>
      {images.map((src, i) => (
        <img
          key={i}
          className="tool-result-image"
          src={src}
          alt="tool result"
          onClick={() => onImageClick(src)}
        />
      ))}
      {text && <pre>{truncated ? text.slice(0, RESULT_PREVIEW_CHARS) : text}</pre>}
      {truncated && (
        <button className="link-btn" onClick={() => setExpanded(true)}>
          Show all ({text.length.toLocaleString()} characters)
        </button>
      )}
    </div>
  );
}

/** First non-empty lines of text, capped, plus how many lines were hidden. */
function firstLines(text: string, cap: number): { lines: string[]; hidden: number } {
  const all = text.split("\n");
  while (all.length > 0 && all[all.length - 1] === "") all.pop();
  return { lines: all.slice(0, cap), hidden: Math.max(0, all.length - cap) };
}

/** Strips the chrome-devtools evaluate_script wrapper text around the returned value. */
function stripEvalWrapper(text: string): string {
  return text
    .replace(/^Script ran on page[^\n]*\n?/, "")
    .replace(/^```json\n?/, "")
    .replace(/```\s*$/, "")
    .trim();
}

/** One subagent child step, summarized to a single line (for the Task/Agent preview). */
function describeStep(item: ChatItem, model: ChatModel): string | null {
  switch (item.kind) {
    case "tool": {
      const child = model.tools[item.toolId];
      if (!child) return null;
      const oneLiner = inputSummary(child.name, child.input);
      return oneLiner ? `${child.name}: ${oneLiner}` : child.name;
    }
    case "text":
      return item.text.split("\n")[0] || null;
    default:
      return null;
  }
}

function PreviewLines({
  lines,
  hidden,
  moreLabel,
  className,
}: {
  lines: string[];
  hidden?: number;
  moreLabel?: string;
  className?: string;
}) {
  if (lines.length === 0 && !moreLabel) return null;
  return (
    <div className={`tool-preview${className ? ` ${className}` : ""}`}>
      {lines.map((line, i) => (
        <div key={i} className="tool-preview-line">
          {line}
        </div>
      ))}
      {(moreLabel || (hidden ?? 0) > 0) && (
        <div className="tool-preview-more">{moreLabel ?? `+${hidden} more lines`}</div>
      )}
    </div>
  );
}

/**
 * Compact multi-line excerpt shown below a collapsed tool card's header —
 * the terminal shows a real preview (a diff, output lines, counts), not just
 * the one-line input summary, so this mirrors that per tool.
 */
function ToolPreview({
  card,
  model,
  onImageClick,
}: {
  card: ToolCard;
  model: ChatModel;
  onImageClick: (src: string) => void;
}) {
  const isSubagent = (card.name === "Task" || card.name === "Agent") && card.children.length > 0;

  if (isSubagent) {
    if (card.result) {
      const finalReport =
        card.structuredResult && typeof card.structuredResult === "object"
          ? ((card.structuredResult as { content?: unknown }).content ?? undefined)
          : undefined;
      const reportText = resultText(finalReport !== undefined ? finalReport : card.result.content);
      const { lines, hidden } = firstLines(reportText, 3);
      return <PreviewLines lines={lines} hidden={hidden} />;
    }
    const steps: string[] = [];
    for (let i = card.children.length - 1; i >= 0 && steps.length < 2; i--) {
      const desc = describeStep(card.children[i], model);
      if (desc) steps.unshift(desc);
    }
    return <PreviewLines lines={steps} />;
  }

  if (!card.result) return null;

  const images = imagesIn(card.result?.content);
  if (images.length > 0) {
    return (
      <div className="tool-preview">
        <img
          className="tool-thumb"
          src={images[0]}
          alt="tool result"
          onClick={() => onImageClick(images[0])}
        />
      </div>
    );
  }

  const text = resultText(card.result.content);
  const isError = card.result.isError;
  const errorClass = isError ? "tool-preview-error" : undefined;

  switch (card.name) {
    case "Edit": {
      if (typeof card.input.old_string === "string" && typeof card.input.new_string === "string") {
        return <DiffView oldStr={card.input.old_string} newStr={card.input.new_string} maxLines={30} path={String(card.input.file_path ?? "")} />;
      }
      break;
    }
    case "Write": {
      if (typeof card.input.content === "string") {
        return <DiffView oldStr="" newStr={card.input.content} maxLines={30} path={String(card.input.file_path ?? "")} />;
      }
      break;
    }
    case "Read": {
      const count = text === "" ? 0 : text.split("\n").length;
      return <PreviewLines lines={[`Read ${count} line${count === 1 ? "" : "s"}`]} />;
    }
    case "Grep":
    case "Glob": {
      const all = text.split("\n").filter((l) => l !== "");
      const { lines } = firstLines(text, 3);
      return <PreviewLines lines={lines} moreLabel={all.length > 3 ? `${all.length} results` : undefined} />;
    }
    case "WebFetch":
    case "WebSearch": {
      const { lines, hidden } = firstLines(text, 3);
      return <PreviewLines lines={lines} hidden={hidden} />;
    }
    case "TaskCreate": {
      const subject = typeof card.input.subject === "string" ? card.input.subject : null;
      return subject ? <PreviewLines lines={[subject]} /> : null;
    }
    case "TaskUpdate": {
      const taskId = typeof card.input.taskId === "string" ? card.input.taskId : null;
      const status = typeof card.input.status === "string" ? card.input.status : null;
      return taskId && status ? <PreviewLines lines={[`#${taskId} → ${status}`]} /> : null;
    }
    case "TodoWrite": {
      const todos = Array.isArray(card.input.todos)
        ? (card.input.todos as { content?: string; status?: string }[])
        : null;
      if (!todos) break;
      const active = todos.find((t) => t?.status === "in_progress");
      if (active?.content) return <PreviewLines lines={[active.content]} />;
      return <PreviewLines lines={[`${todos.length} todo${todos.length === 1 ? "" : "s"}`]} />;
    }
    case "mcp__chrome-devtools__evaluate_script": {
      const { lines, hidden } = firstLines(stripEvalWrapper(text), 3);
      return <PreviewLines lines={lines} hidden={hidden} />;
    }
    case "Bash": {
      const { lines, hidden } = firstLines(text, 4);
      return <PreviewLines lines={lines} hidden={hidden} className={errorClass} />;
    }
    default:
      break;
  }

  const { lines, hidden } = firstLines(text, 3);
  return <PreviewLines lines={lines} hidden={hidden} className={errorClass} />;
}

/** One chat item. Shared by the virtualized list and subagent traces. */
export function ChatItemView({ item, model }: { item: ChatItem; model: ChatModel }) {
  const lightbox = useLightbox();
  switch (item.kind) {
    case "text":
      return <TextMessage role={item.role} text={item.text} />;
    case "image":
      return <ImageMessage dataUri={item.dataUri} onOpen={lightbox.open} />;
    case "thinking":
      return <ThinkingBlock text={item.text} />;
    case "command":
      return <CommandLine command={item.command} args={item.args} />;
    case "output":
      return <CommandOutput text={item.text} error={item.error} />;
    case "compact":
      return <CompactDivider trigger={item.trigger} preTokens={item.preTokens} postTokens={item.postTokens} summary={item.summary} />;
    case "tool": {
      const card = model.tools[item.toolId];
      return card ? <ToolCallCard card={card} model={model} /> : null;
    }
    default:
      return null;
  }
}

/** Plain (non-virtual) list — used for subagent traces, which are short. */
export function ChatItems({ items, model }: { items: ChatItem[]; model: ChatModel }) {
  return (
    <>
      {items.map((item) => (
        <ChatItemView key={item.key} item={item} model={model} />
      ))}
    </>
  );
}

export function ToolCallCard({ card, model }: { card: ToolCard; model: ChatModel }) {
  const [open, setOpen] = useState(false);
  const lightbox = useLightbox();
  const isSubagent = (card.name === "Task" || card.name === "Agent") && card.children.length > 0;
  const summary = inputSummary(card.name, card.input);
  const statusClass = !card.result ? "tool-running" : card.result.isError ? "tool-error" : "tool-ok";

  const finalReport =
    card.structuredResult && typeof card.structuredResult === "object"
      ? ((card.structuredResult as { content?: unknown }).content ?? undefined)
      : undefined;

  return (
    <div className={`tool-card ${statusClass}`}>
      <button className="tool-header" onClick={() => setOpen(!open)}>
        <span className="tool-chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{card.name}</span>
        <span className="tool-summary">{summary}</span>
        {isSubagent && <span className="tool-badge">{card.children.length} steps</span>}
      </button>
      {!open && <ToolPreview card={card} model={model} onImageClick={lightbox.open} />}
      {open && (
        <div className="tool-body">
          {card.name === "Edit" &&
          typeof card.input.old_string === "string" &&
          typeof card.input.new_string === "string" ? (
            <DiffView oldStr={card.input.old_string} newStr={card.input.new_string} path={String(card.input.file_path ?? "")} />
          ) : card.name === "Write" && typeof card.input.content === "string" ? (
            <DiffView oldStr="" newStr={card.input.content} path={String(card.input.file_path ?? "")} />
          ) : (
            <pre className="tool-input">{JSON.stringify(card.input, null, 2)}</pre>
          )}
          {isSubagent && (
            <div className="subagent-trace">
              <div className="subagent-label">Subagent</div>
              <ChatItems items={card.children} model={model} />
            </div>
          )}
          {finalReport !== undefined ? (
            <div className="tool-result">
              <pre>{resultText(finalReport)}</pre>
            </div>
          ) : (
            <ToolResult card={card} onImageClick={lightbox.open} />
          )}
        </div>
      )}
    </div>
  );
}
