// Syntax highlighting, loaded on first use from dist/chunks/highlight.js so
// the grammars stay out of client.js. Shiki core with the JavaScript regex
// engine (no WASM) and a fixed set of languages that covers what a coding
// session prints.
//
// Colors come from the active Perch theme: the tab passes the theme's own
// colors and tokenColors (the same rules VS Code and the Text Editor extension
// use), so a code block reads like the editor does under Plastic, GitHub or
// any other theme. GitHub's default themes are the fallback for a theme with
// no token rules.
import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationRaw, type ThemedToken } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import bash from "@shikijs/langs/bash";
import css from "@shikijs/langs/css";
import diff from "@shikijs/langs/diff";
import dockerfile from "@shikijs/langs/dockerfile";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsx from "@shikijs/langs/jsx";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import sql from "@shikijs/langs/sql";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import yaml from "@shikijs/langs/yaml";
import githubDark from "@shikijs/themes/github-dark-default";
import githubLight from "@shikijs/themes/github-light-default";

export type Token = { content: string; color?: string; fontStyle?: number };

export type HostTheme = {
  key: string;
  dark: boolean;
  colors: Record<string, string>;
  tokenColors: unknown[];
};

let highlighter: Promise<HighlighterCore> | null = null;
const loadedThemes = new Set<string>();

function get(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [githubDark, githubLight],
    langs: [bash, css, diff, dockerfile, go, html, java, javascript, json, jsx, markdown, python, ruby, rust, sql, toml, tsx, typescript, yaml],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

async function themeName(h: HighlighterCore, theme: HostTheme): Promise<string> {
  if (!theme.tokenColors.length) return theme.dark ? "github-dark-default" : "github-light-default";
  const name = `perch-${theme.key}`;
  if (!loadedThemes.has(name)) {
    const raw: ThemeRegistrationRaw = {
      name,
      type: theme.dark ? "dark" : "light",
      colors: theme.colors,
      tokenColors: theme.tokenColors as ThemeRegistrationRaw["tokenColors"],
      settings: theme.tokenColors as ThemeRegistrationRaw["settings"],
    };
    await h.loadTheme(raw);
    loadedThemes.add(name);
  }
  return name;
}

// Lines of tokens, or null for a language this chunk doesn't carry.
export async function tokenize(code: string, lang: string, theme: HostTheme): Promise<Token[][] | null> {
  const h = await get();
  if (!h.getLoadedLanguages().includes(lang)) return null;
  const lines: ThemedToken[][] = h.codeToTokensBase(code, { lang, theme: await themeName(h, theme) });
  return lines.map((line) => line.map((t) => ({ content: t.content, color: t.color, fontStyle: t.fontStyle })));
}
