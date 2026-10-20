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
// Lines starting with # or // are comments. {{name}} is filled from the
// file's variables, then the selected environment (http-client.env.json,
// overridden by http-client.private.env.json, each with an optional
// "$shared" block), plus {{$guid}}, {{$timestamp}} and {{$randomInt min max}}.

export interface HttpRequest {
  name?: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
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

function nameDirective(line: string): string | null {
  const m = /^\s*(?:#|\/\/)\s*@name\s+(\S+)/.exec(line);
  return m ? m[1] : null;
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
    // Before the request line: blank lines, comments, @name, variables.
    for (; i < block.lines.length; i++) {
      const line = block.lines[i];
      if (!line.trim()) continue;
      const named = nameDirective(line);
      if (named) {
        name = named;
        continue;
      }
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
    const bodyLines = block.lines.slice(i);
    // Comment lines after the body are notes about the next request.
    while (bodyLines.length && (!bodyLines[bodyLines.length - 1].trim() || isComment(bodyLines[bodyLines.length - 1]))) {
      bodyLines.pop();
    }
    requests.push({ ...(name ? { name } : {}), method, url, headers, body: bodyLines.join("\n"), startLine });
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

function systemVariable(expr: string): string | null {
  const [name, ...args] = expr.trim().split(/\s+/);
  if (name === "$guid" || name === "$uuid") {
    return crypto.randomUUID();
  }
  if (name === "$timestamp") return String(Math.floor(Date.now() / 1000));
  if (name === "$randomInt") {
    const min = Number(args[0] ?? 0);
    const max = Number(args[1] ?? 1000);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
    return String(Math.floor(min + Math.random() * (max - min)));
  }
  return null;
}

// Fills {{…}} from file variables, then the environment (and its $shared
// block). A variable's own value may use others, a few levels deep.
export function resolveText(
  text: string,
  fileVars: Record<string, string>,
  envs: Environments,
  env: string | null,
  missing: Set<string>,
  depth = 0,
): string {
  const scope: Record<string, string> = { ...(envs.$shared ?? {}), ...(env ? (envs[env] ?? {}) : {}), ...fileVars };
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, expr: string) => {
    if (expr.startsWith("$")) return systemVariable(expr) ?? (missing.add(expr), whole);
    const value = scope[expr];
    if (value === undefined) {
      missing.add(expr);
      return whole;
    }
    return depth < 5 ? resolveText(value, fileVars, envs, env, missing, depth + 1) : value;
  });
}

export interface ResolvedRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
}

export function resolveRequest(
  req: HttpRequest,
  fileVars: Record<string, string>,
  envs: Environments,
  env: string | null,
): { resolved: ResolvedRequest; missing: string[] } {
  const missing = new Set<string>();
  const r = (t: string) => resolveText(t, fileVars, envs, env, missing);
  const resolved = {
    method: req.method,
    url: r(req.url),
    headers: req.headers.map(([k, v]) => [r(k), r(v)] as [string, string]),
    body: r(req.body),
  };
  return { resolved, missing: [...missing] };
}

// A request as .http text, for appending a scratch request to a file.
export function formatRequest(req: { name?: string; method: string; url: string; headers: [string, string][]; body: string }): string {
  const lines: string[] = [];
  if (req.name) lines.push(`# @name ${req.name}`);
  lines.push(`${req.method} ${req.url}`);
  for (const [k, v] of req.headers) lines.push(`${k}: ${v}`);
  if (req.body.trim()) lines.push("", req.body.replace(/\s+$/, ""));
  return lines.join("\n");
}
