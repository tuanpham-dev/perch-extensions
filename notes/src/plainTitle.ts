// A note's first line as plain text, for titles in lists and menus: Markdown
// links become their text, and emphasis, code marks, headings and list
// markers go.
export function plainTitle(body: string, max = 60): string {
  const line = body.split("\n").find((l) => l.trim())?.trim() ?? "";
  const text = line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<([a-z][a-z0-9+.-]*:[^>\s]+)>/gi, "$1")
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_](\S)/g, "$1$2")
    .replace(/(\S)[*_](\s|$)/g, "$1$2")
    .trim();
  if (!text) return "Empty note";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
