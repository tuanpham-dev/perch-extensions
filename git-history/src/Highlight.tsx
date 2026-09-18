// Copied from the claude-viewer extension's src/Highlight.tsx (see
// chunks/highlight.ts for why it is a copy), trimmed to what this extension
// needs: the token hook and a line renderer, with no code-block component.
//
// Highlighted code that shows plain monospace text until the highlighting
// chunk has loaded, then swaps in colored tokens. Unknown languages stay plain.
// Follows the active Perch theme, and re-renders when it changes.
import { useEffect, useState, useSyncExternalStore } from "react";
import { assetUrl, themeApi } from "./client";
import type { HostTheme, Token } from "./chunks/highlight";

type Chunk = { tokenize(code: string, lang: string, theme: HostTheme): Promise<Token[][] | null> };
let chunk: Promise<Chunk> | null = null;

function loadChunk(): Promise<Chunk> {
  if (!assetUrl) return Promise.reject(new Error("not active"));
  chunk ??= import(/* @vite-ignore */ assetUrl("dist/chunks/highlight.js")) as Promise<Chunk>;
  return chunk;
}

const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  py: "python",
  rb: "ruby",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
  htm: "html",
  patch: "diff",
  docker: "dockerfile",
};

export function langFor(nameOrPath: string | undefined | null): string | null {
  if (!nameOrPath) return null;
  const raw = nameOrPath.toLowerCase();
  if (/(^|\/)dockerfile$/.test(raw)) return "dockerfile";
  const ext = raw.includes(".") || raw.includes("/") ? (raw.split(/[/.]/).pop() ?? raw) : raw;
  return ALIASES[ext] ?? ext;
}

// Whether a CSS color is dark, resolved by the browser so hex, rgb() and
// named colors all work.
function isDarkColor(color: string): boolean {
  const probe = document.createElement("span");
  probe.style.color = color;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
  if (!m) return true;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// The active theme, rebuilt when Perch reports a theme change.
let themeVersion = 0;
let currentTheme: HostTheme | null = null;
const themeListeners = new Set<() => void>();
let unsubscribeHost: (() => void) | null = null;

function readTheme(): HostTheme {
  const colors = themeApi?.getThemeColors?.() ?? {};
  const tokenColors = (themeApi?.getTokenColors?.() ?? []) as unknown[];
  const bg = colors["editor.background"] || getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#1e1e1e";
  return { key: hash(JSON.stringify([colors, tokenColors])), dark: isDarkColor(bg), colors, tokenColors };
}

export function activeTheme(): HostTheme {
  currentTheme ??= readTheme();
  return currentTheme;
}

function subscribeTheme(cb: () => void): () => void {
  themeListeners.add(cb);
  if (!unsubscribeHost && themeApi?.onDidChangeColorTheme) {
    unsubscribeHost = themeApi.onDidChangeColorTheme(() => {
      currentTheme = null;
      themeVersion++;
      cache.clear();
      for (const l of themeListeners) l();
    });
  }
  return () => {
    themeListeners.delete(cb);
  };
}

export function stopThemeTracking() {
  unsubscribeHost?.();
  unsubscribeHost = null;
}

function useThemeVersion(): number {
  return useSyncExternalStore(subscribeTheme, () => themeVersion);
}

const cache = new Map<string, Token[][] | null>();

export function useTokens(code: string, lang: string | null): Token[][] | null {
  const version = useThemeVersion();
  const key = `${version}:${lang}:${code}`;
  const [tokens, setTokens] = useState<Token[][] | null>(() => cache.get(key) ?? null);
  useEffect(() => {
    if (!lang || code.length > 200_000) {
      setTokens(null);
      return;
    }
    if (cache.has(key)) {
      setTokens(cache.get(key) ?? null);
      return;
    }
    let cancelled = false;
    loadChunk()
      .then((c) => c.tokenize(code, lang, activeTheme()))
      .then((result) => {
        if (cache.size > 400) cache.clear();
        cache.set(key, result);
        if (!cancelled) setTokens(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, code, lang]);
  return tokens;
}

export function TokenLine({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((t, i) => (
        <span
          key={i}
          style={{
            color: t.color,
            fontStyle: t.fontStyle && t.fontStyle & 1 ? "italic" : undefined,
            fontWeight: t.fontStyle && t.fontStyle & 2 ? 600 : undefined,
          }}
        >
          {t.content}
        </span>
      ))}
    </>
  );
}
