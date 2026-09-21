// Markdown rendering, loaded on first use from dist/chunks/markdown.js so the
// parser, GFM and the sanitizer - most of this extension's weight - stay out
// of client.js, which every Perch page loads whether or not a ticket is ever
// opened. Markdown.tsx beside the entry is the loader.
//
// A ticket body is Markdown because server.js renders Jira's ADF to it, so
// this is what makes headings, lists, code, tables and emphasis show as such.
// Sanitised, because this is other people's text: rehype-sanitize strips any
// raw HTML a comment could carry before it becomes DOM - the same pipeline
// claude-viewer's Message.tsx uses. Links open in a new tab, never in place of
// the app.
import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const components = {
  a({ href, children }: { href?: string; children?: ReactNode }) {
    return (
      <a className="jira-link" href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  // Wide tables scroll inside their own box rather than widening the pane.
  table({ children }: { children?: ReactNode }) {
    return (
      <div className="jira-md-table">
        <table>{children}</table>
      </div>
    );
  },
};

// remark-breaks, because a single newline in Jira is a line break the author
// typed on purpose - plain CommonMark would join those lines into one.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="jira-md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeSanitize]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
