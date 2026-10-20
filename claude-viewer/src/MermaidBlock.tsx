// A ```mermaid block in a message, drawn as a diagram. Falls back to the
// highlighted source plus the parser's message when it doesn't parse.
import { useEffect, useRef, useState } from "react";
import { host } from "./bridge";
import { copyText } from "./clipboard";
import { CodeBlock, useThemeDark } from "./Highlight";

type Renderer = { renderMermaid(source: string, dark: boolean): Promise<string> };
let renderer: Promise<Renderer> | null = null;

function loadRenderer(): Promise<Renderer> {
  if (!host.assetUrl) return Promise.reject(new Error("not active"));
  renderer ??= import(/* @vite-ignore */ host.assetUrl("dist/chunks/mermaid.js")) as Promise<Renderer>;
  return renderer;
}

export function MermaidBlock({ source }: { source: string }) {
  const dark = useThemeDark();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadRenderer()
      .then((r) => r.renderMermaid(source, dark))
      .then((out) => {
        if (cancelled) return;
        setSvg(out);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSvg(null);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [source, dark]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  if (error) {
    return (
      <div className="cv-mermaid-error">
        <CodeBlock code={source} lang={null} />
        <div className="cv-mermaid-message">Couldn't draw this diagram: {error}</div>
      </div>
    );
  }

  const copy = () => {
    copyText(source)
      .then(() => {
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="cv-mermaid">
      {svg === null ? (
        <div className="cv-mermaid-loading">Drawing diagram…</div>
      ) : (
        <div className="cv-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      <button
        className="cv-mermaid-copy"
        title={copied ? "Copied" : "Copy"}
        aria-label={copied ? "Copied" : "Copy diagram source"}
        onClick={copy}
      >
        <span className={`codicon codicon-${copied ? "check" : "copy"}`} aria-hidden="true" />
      </button>
    </div>
  );
}
