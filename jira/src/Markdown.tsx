// Loads the Markdown renderer on first use - see chunks/markdown.tsx for why
// it is a chunk rather than part of client.js - the same way claude-viewer
// loads its syntax highlighter.
//
// Until the chunk arrives (or if it can't), the Markdown source is shown as
// plain text with its line breaks kept. That is what the panel always showed
// before, and Markdown is written to be readable as it stands, so the first
// ticket opened is legible from the first frame rather than blank.
import { useEffect, useState } from "react";
import type { Markdown as MarkdownComponent } from "./chunks/markdown";

type Chunk = { Markdown: typeof MarkdownComponent };

let assetUrl: ((relPath: string) => string) | null = null;
let chunk: Promise<Chunk> | null = null;
let loaded: Chunk | null = null;

export function setMarkdownAssetUrl(fn: ((relPath: string) => string) | null): void {
  assetUrl = fn;
}

function loadChunk(): Promise<Chunk> {
  if (!assetUrl) return Promise.reject(new Error("not active"));
  // One request however many ticket bodies ask at once. A failure is not
  // cached, so the next ticket opened tries again.
  chunk ??= (import(/* @vite-ignore */ assetUrl("dist/chunks/markdown.js")) as Promise<Chunk>).then(
    (mod) => (loaded = mod),
    (err: unknown) => {
      chunk = null;
      throw err;
    },
  );
  return chunk;
}

export default function Markdown({ text }: { text: string }) {
  const [, setReady] = useState(loaded !== null);

  useEffect(() => {
    if (loaded) return;
    let alive = true;
    loadChunk().then(
      () => {
        if (alive) setReady(true);
      },
      () => {
        // Stays on the plain-text rendering below.
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  if (!loaded) return <div className="jira-md jira-md-plain">{text}</div>;
  const Rendered = loaded.Markdown;
  return <Rendered text={text} />;
}
