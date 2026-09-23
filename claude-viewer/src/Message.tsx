// Message rendering: markdown with highlighted code blocks, user bubbles,
// thinking, commands and their output, and the compaction divider.
import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { LinkedText, linkChildren } from "./FileLinks";
import { CodeBlock, langFor } from "./Highlight";
import { formatTokens } from "./usage";

type HastNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: HastNode[] };

type ElementProps = { node?: unknown; children?: ReactNode } & React.HTMLAttributes<HTMLElement>;

// An element whose plain text runs get file and URL links. Code blocks keep
// their highlighting instead (see pre below).
function linked(Tag: string) {
  return function Linked({ node: _node, children, ...props }: ElementProps) {
    const Element = Tag as "span";
    return <Element {...props}>{linkChildren(children)}</Element>;
  };
}

function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

const components = {
  ...Object.fromEntries(["p", "li", "td", "th", "strong", "em", "del", "h1", "h2", "h3", "h4", "h5", "h6"].map((tag) => [tag, linked(tag)])),
  // Only inline code reaches here: pre renders its own code element.
  code: linked("code"),
  pre({ node }: { node?: HastNode }) {
    const code = node?.children?.find((c) => c.tagName === "code");
    const classes = code?.properties?.className;
    const list = Array.isArray(classes) ? classes.map(String) : typeof classes === "string" ? [classes] : [];
    const lang = list.find((c) => c.startsWith("language-"))?.slice("language-".length);
    return <CodeBlock code={hastText(code ?? node)} lang={langFor(lang)} />;
  },
  a({ href, children }: { href?: string; children?: React.ReactNode }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeSanitize]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

export const TextMessage = memo(function TextMessage({
  role,
  text,
  queued,
  pending,
}: {
  role: "user" | "assistant";
  text: string;
  queued?: boolean;
  pending?: boolean;
}) {
  if (role === "user") {
    return (
      <div className="msg msg-user">
        <div className={`msg-user-bubble${pending ? " msg-user-pending" : ""}`}>
          {/* Sent, but not in the transcript yet: Claude Code records a
              message when the turn it belongs to starts, so one sent while
              Claude is working only lands with the next tool result. */}
          {pending && <div className="msg-user-queued">Sent - waiting for Claude to pick it up</div>}
          {/* A queued message is absorbed into the turn that was already
              running, so it shows up between that turn's tool calls rather
              than starting one - the marker says why it sits there. */}
          {queued && <div className="msg-user-queued">Sent while Claude was working</div>}
          <Markdown text={text} />
        </div>
      </div>
    );
  }
  return (
    <div className="msg msg-assistant">
      <Markdown text={text} />
    </div>
  );
});

export function ImageMessage({ dataUri, onOpen }: { dataUri: string; onOpen: (src: string) => void }) {
  return (
    <div className="msg msg-user">
      <img className="msg-image" src={dataUri} alt="Attached image" onClick={() => onOpen(dataUri)} />
    </div>
  );
}

export function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="thinking">
      <summary>Thinking</summary>
      <div className="thinking-body">
        <Markdown text={text} />
      </div>
    </details>
  );
}

export function CommandLine({ command, args }: { command: string; args: string }) {
  return (
    <div className="msg msg-user">
      <div className="cv-command">
        {command === "!" ? (
          <>
            <span className="cv-command-bang">!</span> {args}
          </>
        ) : (
          <>
            <span className="cv-command-name">{command}</span>
            {args ? ` ${args}` : ""}
          </>
        )}
      </div>
    </div>
  );
}

export function CommandOutput({ text, error }: { text: string; error: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const long = lines.length > 12;
  return (
    <div className={`cv-output${error ? " cv-output-error" : ""}`}>
      <pre>
        <LinkedText text={long && !open ? lines.slice(0, 12).join("\n") : text} />
      </pre>
      {long && (
        <button className="link-btn" onClick={() => setOpen(!open)}>
          {open ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

export function CompactDivider({ trigger, preTokens, postTokens, summary }: { trigger: string; preTokens: number | null; postTokens: number | null; summary: string | null }) {
  const counts =
    preTokens !== null ? ` · ${formatTokens(preTokens)} tokens${postTokens !== null ? ` down to ${formatTokens(postTokens)}` : ""}` : "";
  return (
    <div className="cv-compact">
      <div className="cv-compact-rule">
        <span>
          Context compacted{trigger === "manual" ? " by /compact" : ""}
          {counts}
        </span>
      </div>
      {summary && (
        <details className="thinking">
          <summary>Summary Claude continued from</summary>
          <div className="thinking-body">
            <Markdown text={summary} />
          </div>
        </details>
      )}
    </div>
  );
}
