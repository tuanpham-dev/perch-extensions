// Requests to and from curl command lines: "Copy as curl", and pasting a
// curl command (as browser devtools' "Copy as cURL" makes) into an empty
// request.
import type { ResolvedRequest } from "./httpFile";

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function toCurl(req: ResolvedRequest): string {
  const parts = ["curl"];
  if (req.method !== "GET" || req.body || req.bodyFile) parts.push("-X", req.method);
  parts.push(quote(req.url));
  for (const [k, v] of req.headers) parts.push("-H", quote(`${k}: ${v}`));
  if (req.bodyFile) parts.push("--data-binary", quote(`@${req.bodyFile}`));
  else if (req.body) parts.push("--data-raw", quote(req.body));
  return parts.join(" ");
}

// Shell-style words: single and double quotes, backslash escapes, and the
// backslash-newline continuations multi-line curl commands use.
export function shellWords(cmd: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  const s = cmd.replace(/\\\r?\n/g, " ");
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      word += s.slice(i + 1, end === -1 ? s.length : end);
      inWord = true;
      i = end === -1 ? s.length : end + 1;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) i++;
        word += s[i];
        i++;
      }
      i++;
      inWord = true;
    } else if (c === "$" && s[i + 1] === "'") {
      // $'...' ANSI-C quoting, which devtools uses for bodies with newlines.
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "\\" && i + 1 < s.length) {
          const n = s[i + 1];
          word += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
          i += 2;
        } else {
          word += s[i];
          i++;
        }
      }
      i++;
      inWord = true;
    } else if (c === "\\" && i + 1 < s.length) {
      word += s[i + 1];
      i += 2;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      i++;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  if (inWord) words.push(word);
  return words;
}

// null when the text isn't a curl command.
export function fromCurl(cmd: string): ResolvedRequest | null {
  const words = shellWords(cmd.trim());
  if (words[0] !== "curl") return null;
  let method: string | null = null;
  let url = "";
  const headers: [string, string][] = [];
  const data: string[] = [];
  const takesValue = new Set(["-o", "--output", "-w", "--write-out", "--connect-timeout", "-m", "--max-time", "--retry", "-e", "--referer", "-x", "--proxy"]);
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const next = () => words[++i] ?? "";
    if (w === "-X" || w === "--request") method = next().toUpperCase();
    else if (w === "-H" || w === "--header") {
      const h = next();
      const colon = h.indexOf(":");
      if (colon > 0) headers.push([h.slice(0, colon).trim(), h.slice(colon + 1).trim()]);
    } else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json"].includes(w)) {
      data.push(next());
      if (w === "--json" && !headers.some(([k]) => k.toLowerCase() === "content-type")) headers.push(["Content-Type", "application/json"]);
    } else if (w === "--url") url = next();
    else if (w === "-u" || w === "--user") headers.push(["Authorization", `Basic ${btoa(next())}`]);
    else if (w === "-A" || w === "--user-agent") headers.push(["User-Agent", next()]);
    else if (w === "-b" || w === "--cookie") headers.push(["Cookie", next()]);
    else if (takesValue.has(w)) next();
    else if (w.startsWith("-")) continue;
    else if (!url) url = w;
  }
  if (!url) return null;
  return { method: method ?? (data.length ? "POST" : "GET"), url, headers, body: data.join("&") };
}
