// The .http / .rest request-file format, as VS Code's REST Client and
// JetBrains' HTTP client read it:
//
//   @base = http://localhost:3000          file variable
//
//   # @name listProjects                   names the request below
//   GET {{base}}/api/sessions               request line (method optional: GET)
//   Authorization: Bearer {{token}}         headers, until a blank line
//
//   { "body": "after the blank line" }
//   ###                                     separates requests
//
// Lines starting with # or // are comments before the request line and
// among the headers; in the body they are body text, sent as written. A
// "# @no-redirect" line above a request returns a 3xx as it is instead of
// following it. A body of just "< ./file" sends that file (relative to the
// .http file), "<@ ./file" the same with its {{variables}} filled.
//
// {{name}} is filled from the file's variables, then the selected
// environment (http-client.env.json, overridden by
// http-client.private.env.json, each with an optional "$shared" block), plus
// the system variables {{$guid}}, {{$timestamp}}, {{$randomInt min max}},
// {{$datetime iso8601|rfc1123|"format" [offset unit]}} (and
// {{$localDatetime …}}), {{$dotenv NAME}} (a .env file beside the request
// file or above it) and {{$processEnv NAME}} (the Perch server's
// environment). {{login.response.body.$.token}} and
// {{login.response.headers.X-Token}} read the last response of the request
// named "login" in the same file; it is sent first when it hasn't been yet.

export interface HttpRequest {
  name?: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
  // A body read from a file ("< ./data.json"): the path as written, still
  // holding any {{variables}}. bodyFileVars is set for "<@", whose content
  // gets its variables filled too.
  bodyFile?: string;
  bodyFileVars?: boolean;
  // "# @no-redirect": a 3xx comes back as it is.
  noRedirect?: boolean;
  // 0-based line of the request line, for placing its Send button.
  startLine: number;
}

export interface HttpFile {
  variables: Record<string, string>;
  requests: HttpRequest[];
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"];
const REQUEST_LINE = new RegExp(`^(?:(${METHODS.join("|")})\\s+)?(\\S.*?)(?:\\s+HTTP\\/[\\d.]+)?\\s*$`, "i");

function isComment(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("#") || t.startsWith("//");
}

// "# @name login", "// @no-redirect": a directive about the request below.
function directive(line: string): { key: string; value: string } | null {
  const m = /^\s*(?:#|\/\/)\s*@([A-Za-z][\w-]*)(?:\s+(.*?))?\s*$/.exec(line);
  return m ? { key: m[1].toLowerCase(), value: m[2] ?? "" } : null;
}

function fileVariable(line: string): [string, string] | null {
  const m = /^\s*@([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/.exec(line);
  return m ? [m[1], m[2]] : null;
}

export function parseHttpFile(text: string): HttpFile {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const variables: Record<string, string> = {};
  const requests: HttpRequest[] = [];

  // Split into blocks at ### lines.
  const blocks: { start: number; lines: string[] }[] = [];
  let current: { start: number; lines: string[] } = { start: 0, lines: [] };
  lines.forEach((line, i) => {
    if (/^\s*###/.test(line)) {
      blocks.push(current);
      current = { start: i + 1, lines: [] };
    } else {
      current.lines.push(line);
    }
  });
  blocks.push(current);

  for (const block of blocks) {
    let i = 0;
    let name: string | undefined;
    let noRedirect = false;
    // Before the request line: blank lines, comments, directives, variables.
    for (; i < block.lines.length; i++) {
      const line = block.lines[i];
      if (!line.trim()) continue;
      const d = directive(line);
      if (d?.key === "name" && /^\S+$/.test(d.value)) name = d.value;
      if (d?.key === "no-redirect") noRedirect = true;
      if (isComment(line)) continue;
      const variable = fileVariable(line);
      if (variable) {
        variables[variable[0]] = variable[1];
        continue;
      }
      break;
    }
    if (i >= block.lines.length) continue;
    const m = REQUEST_LINE.exec(block.lines[i]);
    if (!m) continue;
    const startLine = block.start + i;
    let url = m[2].trim();
    const method = (m[1] ?? "GET").toUpperCase();
    i++;
    // Query continuation lines: "?a=1" / "&b=2" right under the URL.
    while (i < block.lines.length && /^\s*[?&]/.test(block.lines[i])) {
      url += block.lines[i].trim();
      i++;
    }
    const headers: [string, string][] = [];
    for (; i < block.lines.length; i++) {
      const line = block.lines[i];
      if (!line.trim()) {
        i++;
        break;
      }
      if (isComment(line)) continue;
      const colon = line.indexOf(":");
      if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
    // Everything up to the next ### is body, "#" and "//" lines included: a
    // shell script, a YAML document or a Markdown heading is body text.
    const bodyLines = block.lines.slice(i);
    while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();
    const body = bodyLines.join("\n");
    const fromFile = /^\s*<(@)?\s+(\S.*?)\s*$/.exec(body);
    requests.push({
      ...(name ? { name } : {}),
      method,
      url,
      headers,
      body: fromFile ? "" : body,
      ...(fromFile ? { bodyFile: fromFile[2], ...(fromFile[1] ? { bodyFileVars: true } : {}) } : {}),
      ...(noRedirect ? { noRedirect: true } : {}),
      startLine,
    });
  }
  return { variables, requests };
}

// ---- Variables ----

export type Environments = Record<string, Record<string, string>>;

// http-client.env.json, overridden key by key by http-client.private.env.json.
export function mergeEnvironments(shared: Environments, priv: Environments): Environments {
  const out: Environments = {};
  for (const source of [shared, priv]) {
    for (const [env, vars] of Object.entries(source ?? {})) {
      if (!vars || typeof vars !== "object") continue;
      out[env] = { ...(out[env] ?? {}) };
      for (const [k, v] of Object.entries(vars)) out[env][k] = String(v);
    }
  }
  return out;
}

export function environmentNames(envs: Environments): string[] {
  return Object.keys(envs).filter((n) => n !== "$shared");
}

// What a request's {{…}} can read beyond the file and the environment:
// values only the server knows ($dotenv, $processEnv, fetched for the names
// the file uses), the last exchange of each named request (for chaining),
// and the clock (fixed in tests).
export interface ResolveContext {
  dotenv?: Record<string, string>;
  processEnv?: Record<string, string>;
  named?: Record<string, NamedExchange>;
  now?: Date;
}

// One named request's last send, as chaining reads it.
export interface NamedExchange {
  request: { headers: [string, string][]; body: string };
  response: { headers: [string, string][]; body: string };
}

// Words of a system variable's arguments; "…" and '…' keep spaces.
function argWords(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const OFFSET_UNITS: Record<string, (d: Date, n: number, utc: boolean) => void> = {
  y: (d, n, u) => (u ? d.setUTCFullYear(d.getUTCFullYear() + n) : d.setFullYear(d.getFullYear() + n)),
  M: (d, n, u) => (u ? d.setUTCMonth(d.getUTCMonth() + n) : d.setMonth(d.getMonth() + n)),
  w: (d, n) => d.setTime(d.getTime() + n * 7 * 86_400_000),
  d: (d, n) => d.setTime(d.getTime() + n * 86_400_000),
  h: (d, n) => d.setTime(d.getTime() + n * 3_600_000),
  m: (d, n) => d.setTime(d.getTime() + n * 60_000),
  s: (d, n) => d.setTime(d.getTime() + n * 1000),
  ms: (d, n) => d.setTime(d.getTime() + n),
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");

// A Day.js-style format ("YYYY-MM-DD HH:mm:ss", "[literal]" kept as is), in
// UTC or local time.
export function formatDate(date: Date, format: string, utc: boolean): string {
  const get = {
    Y: utc ? date.getUTCFullYear() : date.getFullYear(),
    M: utc ? date.getUTCMonth() : date.getMonth(),
    D: utc ? date.getUTCDate() : date.getDate(),
    d: utc ? date.getUTCDay() : date.getDay(),
    H: utc ? date.getUTCHours() : date.getHours(),
    m: utc ? date.getUTCMinutes() : date.getMinutes(),
    s: utc ? date.getUTCSeconds() : date.getSeconds(),
    S: utc ? date.getUTCMilliseconds() : date.getMilliseconds(),
  };
  const offset = utc ? 0 : -date.getTimezoneOffset();
  const zone = (sep: string) => `${offset < 0 ? "-" : "+"}${pad(Math.trunc(offset / 60))}${sep}${pad(offset % 60)}`;
  const tokens: Record<string, () => string> = {
    YYYY: () => String(get.Y),
    YY: () => pad(get.Y % 100),
    MMMM: () => MONTHS[get.M],
    MMM: () => MONTHS[get.M].slice(0, 3),
    MM: () => pad(get.M + 1),
    M: () => String(get.M + 1),
    DD: () => pad(get.D),
    D: () => String(get.D),
    dddd: () => DAYS[get.d],
    ddd: () => DAYS[get.d].slice(0, 3),
    HH: () => pad(get.H),
    H: () => String(get.H),
    hh: () => pad(get.H % 12 || 12),
    h: () => String(get.H % 12 || 12),
    mm: () => pad(get.m),
    m: () => String(get.m),
    ss: () => pad(get.s),
    s: () => String(get.s),
    SSS: () => pad(get.S, 3),
    A: () => (get.H < 12 ? "AM" : "PM"),
    a: () => (get.H < 12 ? "am" : "pm"),
    ZZ: () => zone(""),
    Z: () => zone(":"),
    X: () => String(Math.floor(date.getTime() / 1000)),
    x: () => String(date.getTime()),
  };
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|SSS|A|a|ZZ|Z|X|x/g, (tok, literal) =>
    literal !== undefined ? literal : tokens[tok](),
  );
}

// {{$datetime iso8601}}, {{$datetime rfc1123 -1 d}}, {{$datetime "DD.MM.YYYY"}};
// $localDatetime is the same in local time (the browser's, where requests
// are resolved).
function datetime(args: string[], utc: boolean, now: Date): string | null {
  const [format, amount, unit] = args;
  if (!format) return null;
  const date = new Date(now.getTime());
  if (amount !== undefined) {
    const n = Number(amount);
    const add = OFFSET_UNITS[unit ?? ""];
    if (!Number.isInteger(n) || !add) return null;
    add(date, n, utc);
  }
  if (format === "iso8601") return utc ? date.toISOString() : formatDate(date, "YYYY-MM-DDTHH:mm:ss.SSSZ", false);
  if (format === "rfc1123") return utc ? date.toUTCString() : formatDate(date, "ddd, DD MMM YYYY HH:mm:ss ZZ", false);
  return formatDate(date, format, utc);
}

function systemVariable(expr: string, ctx: ResolveContext): string | null {
  const m = /^(\$\w+)\s*(.*)$/.exec(expr.trim());
  if (!m) return null;
  const name = m[1];
  const args = argWords(m[2]);
  if (name === "$guid" || name === "$uuid") {
    return crypto.randomUUID();
  }
  if (name === "$timestamp") return String(Math.floor((ctx.now ?? new Date()).getTime() / 1000));
  if (name === "$randomInt") {
    const min = Number(args[0] ?? 0);
    const max = Number(args[1] ?? 1000);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
    return String(Math.floor(min + Math.random() * (max - min)));
  }
  if (name === "$datetime" || name === "$localDatetime") return datetime(args, name === "$datetime", ctx.now ?? new Date());
  if (name === "$dotenv") return args[0] ? (ctx.dotenv?.[args[0]] ?? null) : null;
  if (name === "$processEnv") return args[0] ? (ctx.processEnv?.[args[0]] ?? null) : null;
  return null;
}

// The names a text's {{$dotenv NAME}} and {{$processEnv NAME}} ask for, so
// the server is asked for those values and no others.
export function serverVariableNames(text: string): { dotenv: string[]; processEnv: string[] } {
  const dotenv = new Set<string>();
  const processEnv = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*\$(dotenv|processEnv)\s+([^\s{}]+)\s*\}\}/g)) {
    (m[1] === "dotenv" ? dotenv : processEnv).add(m[2]);
  }
  return { dotenv: [...dotenv], processEnv: [...processEnv] };
}

// ---- Request chaining ----

const CHAIN = /^([A-Za-z_][\w-]*)\.(request|response)\.(body|headers)(?:\.(.*))?$/;

// The request names a text reads from with {{name.response.…}}.
export function chainedNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const c = CHAIN.exec(m[1]);
    if (c) names.add(c[1]);
  }
  return [...names];
}

// A small JSONPath: $, .key, ['key'], ["key"], [0]. Enough for "the token
// out of the login response"; filters and wildcards aren't supported.
export function jsonPath(value: unknown, path: string): unknown {
  const p = path.trim();
  if (!p.startsWith("$")) return undefined;
  const re = /\.([^.[\]]+)|\[\s*(-?\d+)\s*\]|\[\s*'([^']*)'\s*\]|\[\s*"([^"]*)"\s*\]/g;
  let at = 1;
  let cur: unknown = value;
  for (let m = re.exec(p); m; m = re.exec(p)) {
    if (m.index !== at) return undefined;
    at = re.lastIndex;
    if (cur === null || typeof cur !== "object") return undefined;
    if (m[2] !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      const i = Number(m[2]);
      cur = cur[i < 0 ? cur.length + i : i];
    } else {
      cur = (cur as Record<string, unknown>)[m[1] ?? m[3] ?? m[4]];
    }
  }
  return at === p.length ? cur : undefined;
}

function chainedValue(expr: string, ctx: ResolveContext): string | null {
  const c = CHAIN.exec(expr);
  if (!c) return null;
  const [, name, side, part, rest = "*"] = c;
  const exchange = ctx.named?.[name]?.[side as "request" | "response"];
  if (!exchange) return null;
  if (part === "headers") {
    const found = exchange.headers.find(([k]) => k.toLowerCase() === rest.toLowerCase());
    return found ? found[1] : null;
  }
  if (rest === "*" || rest === "") return exchange.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(exchange.body);
  } catch {
    return null;
  }
  const v = jsonPath(parsed, rest);
  if (v === undefined) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

// Fills {{…}} from file variables, then the environment (and its $shared
// block), system variables and earlier named responses. A variable's own
// value may use others, a few levels deep.
export function resolveText(
  text: string,
  fileVars: Record<string, string>,
  envs: Environments,
  env: string | null,
  missing: Set<string>,
  ctx: ResolveContext = {},
  depth = 0,
): string {
  const scope: Record<string, string> = { ...(envs.$shared ?? {}), ...(env ? (envs[env] ?? {}) : {}), ...fileVars };
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, expr: string) => {
    if (expr.startsWith("$")) return systemVariable(expr, ctx) ?? (missing.add(expr), whole);
    const value = scope[expr];
    if (value === undefined) {
      const chained = chainedValue(expr, ctx);
      if (chained !== null) return chained;
      missing.add(expr);
      return whole;
    }
    return depth < 5 ? resolveText(value, fileVars, envs, env, missing, ctx, depth + 1) : value;
  });
}

export interface ResolvedRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
  // A "< ./file" body: the path with its variables filled, still relative
  // to the .http file. The server reads it.
  bodyFile?: string;
  noRedirect?: boolean;
}

export function resolveRequest(
  req: HttpRequest,
  fileVars: Record<string, string>,
  envs: Environments,
  env: string | null,
  ctx: ResolveContext = {},
): { resolved: ResolvedRequest; missing: string[] } {
  const missing = new Set<string>();
  const r = (t: string) => resolveText(t, fileVars, envs, env, missing, ctx);
  const resolved: ResolvedRequest = {
    method: req.method,
    url: r(req.url),
    headers: req.headers.map(([k, v]) => [r(k), r(v)] as [string, string]),
    body: r(req.body),
    ...(req.bodyFile ? { bodyFile: r(req.bodyFile) } : {}),
    ...(req.noRedirect ? { noRedirect: true } : {}),
  };
  return { resolved, missing: [...missing] };
}

// A request as .http text, for appending a scratch request to a file.
export function formatRequest(req: { name?: string; method: string; url: string; headers: [string, string][]; body: string; noRedirect?: boolean }): string {
  const lines: string[] = [];
  if (req.name) lines.push(`# @name ${req.name}`);
  if (req.noRedirect) lines.push("# @no-redirect");
  lines.push(`${req.method} ${req.url}`);
  for (const [k, v] of req.headers) lines.push(`${k}: ${v}`);
  if (req.body.trim()) lines.push("", req.body.replace(/\s+$/, ""));
  return lines.join("\n");
}
