// jira server hook: issue listing and "Start work" worktree creation against
// the Jira Cloud REST API v3.
//
// Unlike the sibling github extension - which shells out to `gh` and so holds
// no credentials of its own - Jira has no ubiquitous CLI to inherit an
// authenticated session from, so this extension owns the credential. It is
// NOT a manifest setting: configuration values live in the settings document
// the client GETs, merges and PUTs back whole, which is the wrong home for an
// API token. It lives in the host's per-extension secret store instead
// (activate({ secrets }) - see docs/EXTENSION_API.md in the main perch
// repo), which no client can read and no document write can reach. Only the
// site URL and email are ordinary settings.
//
// Every error that can reach a response body is passed through scrub() first,
// so a token echoed back by Atlassian in a message can't leak that way either.
//
// The worktree-creation helpers (repoRoot/gitCommonDir/ensureExcluded/
// resolveLocation) reimplement what core does in server/src/gitWorktrees.ts
// (in the main perch repo) - an extension can't import core, and this
// registry repo can't import across extensions either, so they're copied with
// this comment naming the source rather than silently duplicated. Note the
// bundled "worktrees" extension has no server hook at all: it's a thin client
// that calls ctx.app.newWorktree, and core owns the git work. The sibling
// github extension carries the same copy.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accept,
  activeKey,
  addCluster,
  allowedClusterActions,
  applyProposal,
  badgeCount,
  canArchive,
  canDelete,
  clusterState,
  diffEvents,
  moveTicket,
  newBatch,
  newTicket,
  OPEN_FOR_ADD,
  pendingFeedbackCount,
  removeCluster,
  renameBatch,
  renameCluster,
  setBranch,
  setFeedbackDraft,
  ticketCounts,
} from "./batchModel.mjs";
import { createBatchStore, newId } from "./batchStore.mjs";
import { buildClusterPrompt, heuristicClusters, parseClusterReply, singleCluster } from "./analysis.mjs";
import { createBatchRunner } from "./batchRunner.mjs";
import { discoverSkills, parseSkillPaths } from "./skills.mjs";

// Where the batch store and the worker CLI live. PERCH_CONFIG_DIR moves the
// whole profile, so a second instance keeps its own batches - the same rule
// core's own configDir follows.
const configDir =
  process.env.PERCH_CONFIG_DIR ||
  (process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "perch")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "perch"));

// Module-level, because deactivate() has to reach them and it is called with
// no arguments after the routes are already gone. A disable -> enable cycle
// re-runs activate() on this same resident module, so both are replaced there
// rather than accumulated.
let activeRunner = null;
let openBoards = new Set();

const API_TIMEOUT = 15000;
const GIT_TIMEOUT = 15000;
const FETCH_TIMEOUT = 60000; // a cold `git fetch` on a large repo outlasts 15s
const TOKEN_NAME = "apiToken";
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
// One `key in (...)` query can only name so many tickets before the JQL gets
// unwieldy; a pasted list longer than this is fetched in several calls.
const KEY_CHUNK = 50;

// An error carrying the status a route should answer with. The batch routes
// and the control socket both raise these, so a refusal reads the same
// whether it reaches a browser or an agent's terminal. Copied from the
// agent-tasks extension's server.js, which needed exactly this first.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);
const notFound = (message) => new HttpError(404, message);
const conflict = (message) => new HttpError(409, message);
const tooOld = (message) => new HttpError(501, message);

// Express 4 does not catch a rejected async handler: it becomes an unhandled
// rejection, and a core older than the guard for that exits the whole server.
// Every async route added here goes through this rather than trusting the
// core it happens to be installed on.
function route(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      const status = typeof err?.status === "number" ? err.status : 500;
      if (status >= 500) console.error("[ext:perch.jira]", err?.stack ?? err);
      if (!res.headersSent) res.status(status).json({ error: err?.message ?? String(err) });
      else res.end();
    });
  };
}

// Single-quote for a POSIX shell. The launch line is typed into a real shell
// prompt, so a worktree path with a space in it - or an apostrophe in a
// cluster name - must not become two arguments.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// The built-in lists leave Done out. The board lets recently finished tickets
// back in, so a Done column shows real movement instead of always standing
// empty - see openClause. The table and sidebar never pass `board`, so their
// query is byte-identical to what it has always been.
export function openClause(board, days) {
  if (!board || !Number.isInteger(days) || days <= 0) return "statusCategory != Done";
  return `(statusCategory != Done OR statusCategoryChangedDate >= -${days}d)`;
}

function mineJql(board, days) {
  return `assignee = currentUser() AND ${openClause(board, days)} ORDER BY updated DESC`;
}

function projectJql(key, board, days) {
  return `project = "${key}" AND ${openClause(board, days)} ORDER BY updated DESC`;
}

// ---- Filters -> JQL ----
//
// The panel's filters are applied by narrowing the QUERY, not by sifting the
// rows that came back: a pane holds at most jira.maxResults (30) issues out
// of a backlog of hundreds, so filtering those would report "no In Review
// tickets" for a project that plainly has some. Everything below turns the
// panel's facet selections into JQL fragments that are AND-ed onto whatever
// base query the scope already uses - including a user's own jira.jql.

// A facet value goes into a quoted JQL string literal, so the two characters
// that could end or escape that literal are escaped first. Everything else -
// spaces, parentheses, non-ASCII - is legal inside quotes and left alone.
function escapeJql(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function inClause(field, values) {
  return `${field} in (${values.map((v) => `"${escapeJql(v)}"`).join(", ")})`;
}

// The sentinel the assignee facet uses for "nobody". Jira has no accountId
// for it, so it becomes `assignee is EMPTY` rather than a member of the
// `in (...)` list - and it can be ticked alongside real people, which is why
// the two halves are OR-ed rather than one replacing the other.
const UNASSIGNED = "unassigned";

function assigneeClause(values) {
  const parts = [];
  const ids = values.filter((v) => v !== UNASSIGNED);
  if (ids.length > 0) parts.push(inClause("assignee", ids));
  if (values.includes(UNASSIGNED)) parts.push("assignee is EMPTY");
  return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
}

// The search box. `~` is Jira's text-match operator and here only reaches the
// summary; someone typing an issue key means "this ticket", which no summary
// match would find, so a key-shaped term matches the key as well. The key
// half needs no quoting: ISSUE_KEY admits only letters, digits, _ and -.
function textClause(text) {
  const term = `summary ~ "${escapeJql(text)}"`;
  return ISSUE_KEY.test(text) ? `(key = ${text.toUpperCase()} OR ${term})` : term;
}

function filterClauses(filters) {
  const clauses = [];
  if (filters.status.length > 0) clauses.push(inClause("status", filters.status));
  if (filters.assignee.length > 0) clauses.push(assigneeClause(filters.assignee));
  if (filters.type.length > 0) clauses.push(inClause("issuetype", filters.type));
  if (filters.priority.length > 0) clauses.push(inClause("priority", filters.priority));
  if (filters.text) clauses.push(textClause(filters.text));
  return clauses;
}

// ORDER BY is not a condition and cannot be AND-ed onto, so it is split off,
// the conditions are combined, and it is appended again untouched. Split on
// the LAST match: a quoted value can contain the words "order by", and only
// the trailing clause is the real one.
const ORDER_BY = /\border\s+by\b/gi;

function splitOrderBy(jql) {
  let last = -1;
  let match;
  ORDER_BY.lastIndex = 0;
  while ((match = ORDER_BY.exec(jql)) !== null) last = match.index;
  if (last === -1) return { where: jql.trim(), order: "" };
  return { where: jql.slice(0, last).trim(), order: jql.slice(last).trim() };
}

// The base condition is parenthesised because a user's jira.jql may be a bare
// OR: without the parens, `a OR b AND status in (...)` would bind the AND to
// `b` alone and quietly widen the result instead of narrowing it. With no
// filters the base is returned untouched, so an unfiltered pane issues
// byte-identical JQL to the one it always did.
//
// A chosen sort REPLACES the base query's ORDER BY rather than being added to
// it: the point of sorting by key is to get the lowest keys in the backlog,
// which means the order Jira applies before it cuts the result to
// maxResults. `key` breaks ties, so tickets that share a status or priority
// come back in the same order every time instead of shuffling between loads.
export function composeJql(base, filters, sort = null) {
  const clauses = filterClauses(filters);
  if (clauses.length === 0 && !sort) return base;
  const { where, order } = splitOrderBy(base);
  const conditions = where ? [clauses.length > 0 ? `(${where})` : where, ...clauses] : clauses;
  const orderBy = sort
    ? `ORDER BY ${SORT_FIELDS[sort.field]} ${sort.dir.toUpperCase()}${sort.field === "key" ? "" : ", key ASC"}`
    : order;
  return [conditions.join(" AND "), orderBy].filter(Boolean).join(" ");
}

// The panel's sort keys, and the JQL field each orders by.
const SORT_FIELDS = {
  key: "key",
  summary: "summary",
  status: "status",
  priority: "priority",
  assignee: "assignee",
  type: "issuetype",
  created: "created",
  updated: "updated",
};

// Null when absent or not one of the known fields - an unknown field would
// otherwise be pasted straight into the JQL.
export function readSortParams(query) {
  const field = typeof query.sort === "string" ? query.sort : "";
  const dir = typeof query.dir === "string" ? query.dir.toLowerCase() : "";
  if (!Object.hasOwn(SORT_FIELDS, field) || (dir !== "asc" && dir !== "desc")) return null;
  return { field, dir };
}

// Repeated params (?status=A&status=B) rather than one comma-joined value: a
// Jira status name can itself contain a comma, so splitting on one would
// invent facet values that never existed.
function readFilterParams(query) {
  const list = (name) => {
    const raw = query[name];
    return [
      ...new Set(
        (Array.isArray(raw) ? raw : [raw])
          .filter((v) => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ];
  };
  return {
    status: list("status"),
    assignee: list("assignee"),
    type: list("type"),
    priority: list("priority"),
    text: typeof query.text === "string" ? query.text.trim() : "",
  };
}

// ---- Facet and worktree helpers ----
//
// composeJql, parseWorktreeList and shortenHome are exported for
// src/serverModel.test.ts. They are the parts of this file that decide what
// gets queried, which worktrees are offered, and whether a session is found -
// each wrong in a way no type check catches. Nothing imports them at runtime.

// Statuses and issue types repeat heavily across workflows, so the site-wide
// lists are deduplicated by name and capped: the picker wants the distinct
// names a user would recognise, not one row per workflow that defines them.
const FACET_CAP = 100;

function uniqueByName(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item.name || seen.has(item.name)) continue;
    seen.add(item.name);
    out.push(item);
    if (out.length >= FACET_CAP) break;
  }
  return out;
}

// Core reports session and worktree paths with the home directory shortened
// to "~" (its shortenHome), while this extension's own routes take and return
// absolute paths - openSessionWindow's createCwd is handed one today. A
// caller matching a worktree to its session needs both conventions, so every
// row below carries both rather than making the client guess $HOME.
export function shortenHome(abs) {
  const home = os.homedir();
  if (!home) return abs;
  if (abs === home) return "~";
  return abs.startsWith(`${home}/`) ? `~${abs.slice(home.length)}` : abs;
}

// git says why it failed across several lines, and the ones after the first
// are advice for a terminal, not for a one-line note in a panel: a failed
// fetch spends three of its four lines telling you to check your access
// rights. The first line is the reason; keep that, capped so a pathological
// one cannot push the rest of the note off screen.
export function firstLine(text) {
  const line = String(text ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return "git fetch origin failed";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function parseWorktreeList(out) {
  const rows = [];
  let current = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim(), branch: null, head: null, detached: false };
      rows.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    else if (line.trim() === "detached") current.detached = true;
  }
  return rows;
}

// A large site has more than one page of projects; capped so a pathological
// one can neither hang the request nor fill the picker with thousands of rows.
const PROJECT_PAGE = 100;
const PROJECT_CAP = 500;

function run(cmd, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

const git = (args, cwd, timeout = GIT_TIMEOUT) => run("git", args, cwd, timeout);

// ---- Atlassian Document Format -> Markdown ----
//
// v3 returns `description` and comment bodies as ADF trees rather than text.
// They are rendered to Markdown (GFM) instead of being flattened: the panel
// renders Markdown, so headings, lists, code, tables and emphasis survive
// into the ticket view, and the agent's brief is Markdown too - which is what
// an agent reads best. Calling /rest/api/2/ purely to get a plain-text
// description would mean keeping a deprecated API surface alive for one field.
//
// Exported for src/serverModel.test.ts; nothing imports it at runtime.

// Characters that would otherwise turn a user's plain text into markup. `_`
// is left alone on purpose: GFM never emphasises inside a word, so
// snake_case identifiers - common in tickets - stay readable in the brief.
const MD_SPECIAL = /([\\`*[\]<>])/g;

function escapeMd(text) {
  return text.replace(MD_SPECIAL, "\\$1");
}

// Emphasis markers must hug the text: `** bold**` is not bold in Markdown, so
// leading and trailing whitespace is moved outside the markers.
function wrap(text, marker) {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match || !match[2]) return text;
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

// Inline code whose content itself holds backticks needs a longer fence.
function inlineCode(value) {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

function plainText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return typeof node.text === "string" ? node.text : "";
  if (node.type === "hardBreak") return "\n";
  return Array.isArray(node.content) ? node.content.map(plainText).join("") : "";
}

function textNode(node) {
  const value = typeof node.text === "string" ? node.text : "";
  const marks = Array.isArray(node.marks) ? node.marks : [];
  const has = (type) => marks.some((mark) => mark?.type === type);
  // A text node's URL lives in its `marks`, not in the text - so collecting
  // only `node.text` silently drops every hyperlink. That cost real context
  // once: "Preview: <link>  MR: <link>" flattened to "Preview:  MR:" and the
  // agent never saw either URL.
  const href = marks.find((mark) => mark?.type === "link")?.attrs?.href;

  if (has("code")) {
    const code = inlineCode(value);
    return href ? `[${code}](${href})` : code;
  }
  let out = escapeMd(value);
  if (has("strong")) out = wrap(out, "**");
  if (has("em")) out = wrap(out, "*");
  if (has("strike")) out = wrap(out, "~~");
  if (href) out = !value || value === href ? `<${href}>` : `[${out}](${href})`;
  return out;
}

function inlineNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : []).map(inlineNode).join("");
}

// Nodes that carry their whole meaning in attrs and have no `content`, so a
// plain recursion would render them as nothing:
//   inlineCard/blockCard/embedCard  a "smart link" - a bare pasted URL
//   mention                         "@Someone", the cc: in a comment
//   emoji / status / date           inline chips
//   media                           an attached file or screenshot
function inlineNode(node) {
  if (!node || typeof node !== "object") return "";
  switch (node.type) {
    case "text":
      return textNode(node);
    case "hardBreak":
      return "\n";
    case "mention": {
      const name = String(node.attrs?.text ?? "").replace(/^@/, "");
      return name ? `@${escapeMd(name)}` : "";
    }
    case "emoji":
      return node.attrs?.text ?? node.attrs?.shortName ?? "";
    case "status":
      return node.attrs?.text ? inlineCode(String(node.attrs.text).toUpperCase()) : "";
    case "date":
      return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : "";
    case "inlineCard": {
      const url = node.attrs?.url ?? node.attrs?.data?.url ?? "";
      return url ? `<${url}>` : "";
    }
    case "media": {
      const name = node.attrs?.alt || node.attrs?.id || "file";
      return `*(attachment: ${escapeMd(String(name))})*`;
    }
    default:
      return inlineNodes(node.content);
  }
}

// Every line after the first is indented to sit under the first line's text,
// which is how a list item's continuation and its nested lists stay inside
// it. Depth comes from the recursion: each nested list adds its own marker's
// width of indent.
function hang(marker, body) {
  const lines = body.split("\n");
  const pad = " ".repeat(marker.length);
  return [marker + lines[0], ...lines.slice(1).map((line) => (line ? pad + line : line))].join("\n");
}

function listItem(item, marker) {
  const body = (Array.isArray(item?.content) ? item.content : [])
    .map(blockNode)
    .filter(Boolean)
    .join("\n");
  return hang(marker, body || "");
}

function quote(body) {
  return body
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

// A GFM cell holds one line, so a cell's paragraphs are joined with <br> and
// a literal pipe is escaped. GFM also requires a header row: when Jira's
// first row is ordinary cells, it is used as the header all the same rather
// than inventing column names.
function tableNode(node) {
  const rows = (Array.isArray(node.content) ? node.content : []).map((row) =>
    (Array.isArray(row?.content) ? row.content : []).map((cell) =>
      (Array.isArray(cell?.content) ? cell.content : [])
        .map(blockNode)
        .filter(Boolean)
        .join("<br>")
        .replace(/\n/g, "<br>")
        .replace(/\|/g, "\\|"),
    ),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length), 1);
  const pad = (row) => [...row, ...Array(width - row.length).fill("")];
  const line = (row) => `| ${pad(row).join(" | ")} |`;
  return [line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

const PANEL_LABEL = { info: "Info", note: "Note", warning: "Warning", error: "Error", success: "Success", tip: "Tip" };

function blocks(nodes, joiner = "\n\n") {
  return (Array.isArray(nodes) ? nodes : []).map(blockNode).filter(Boolean).join(joiner);
}

function blockNode(node) {
  if (!node || typeof node !== "object") return "";
  switch (node.type) {
    case "paragraph":
      return inlineNodes(node.content);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `${"#".repeat(level)} ${inlineNodes(node.content)}`;
    }
    case "bulletList":
      return (node.content ?? []).map((item) => listItem(item, "- ")).join("\n");
    case "orderedList": {
      const start = Number(node.attrs?.order) || 1;
      return (node.content ?? []).map((item, i) => listItem(item, `${start + i}. `)).join("\n");
    }
    case "taskList":
      return (node.content ?? [])
        .map((item) =>
          item?.type === "taskItem"
            ? hang(item.attrs?.state === "DONE" ? "- [x] " : "- [ ] ", inlineNodes(item.content))
            : blockNode(item),
        )
        .join("\n");
    case "decisionList":
      return (node.content ?? []).map((item) => hang("- ", inlineNodes(item?.content))).join("\n");
    case "codeBlock": {
      const code = plainText(node).replace(/\n+$/, "");
      const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(longest + 1);
      return `${fence}${node.attrs?.language ?? ""}\n${code}\n${fence}`;
    }
    case "blockquote":
      return quote(blocks(node.content));
    case "panel": {
      const label = PANEL_LABEL[node.attrs?.panelType] ?? "Note";
      return quote(`**${label}:** ${blocks(node.content)}`);
    }
    case "rule":
      return "---";
    case "table":
      return tableNode(node);
    case "expand":
    case "nestedExpand": {
      const title = node.attrs?.title ? `**${escapeMd(String(node.attrs.title))}**\n\n` : "";
      return `${title}${blocks(node.content)}`;
    }
    case "blockCard":
    case "embedCard": {
      const url = node.attrs?.url ?? node.attrs?.data?.url ?? "";
      return url ? `<${url}>` : "";
    }
    case "mediaSingle":
    case "mediaGroup":
      return (node.content ?? []).map(inlineNode).filter(Boolean).join("\n");
    default:
      // An unknown block still yields whatever text it holds rather than
      // vanishing - Atlassian adds node types faster than this file does.
      return Array.isArray(node.content) ? blocks(node.content) : inlineNode(node);
  }
}

export function adfToMarkdown(doc) {
  if (!doc || typeof doc !== "object") return "";
  return (doc.type === "doc" ? blocks(doc.content) : blockNode(doc)).replace(/\n{3,}/g, "\n\n").trim();
}

export function activate({ router, getSettings, secrets, host, ai, log = console.log }) {
  // Host capabilities an extension needs may simply not exist: this ships from
  // the registry and can be installed on ANY core, including one older than
  // extension secret storage. Reaching for a missing one used to throw inside
  // an async route with no catch, which Express 4 does not handle - it becomes
  // an unhandled rejection, and Node exits the whole server process. One
  // extension installed on an old core should never be able to do that.
  //
  // So the capability is probed once and substituted when absent, the same way
  // agent-monitor degrades when /api/agents is missing. Every call site below
  // uses `store`, so an old core simply looks like "no token stored yet" and
  // the panel renders its ordinary not-configured state.
  const secretsAvailable =
    Boolean(secrets) && typeof secrets.get === "function" && typeof secrets.set === "function";
  const NO_SECRETS = "This perch is too old to store extension secrets - update it to add a Jira API token.";
  const store = secretsAvailable
    ? secrets
    : {
        get: async () => null,
        set: async () => {
          throw new Error(NO_SECRETS);
        },
      };
  if (!secretsAvailable) {
    console.warn(`jira: ${NO_SECRETS}`);
  }
  // ---- Config ----

  async function readConfig() {
    const settings = await getSettings();
    const rawSite = typeof settings["jira.siteUrl"] === "string" ? settings["jira.siteUrl"].trim() : "";
    const email = typeof settings["jira.email"] === "string" ? settings["jira.email"].trim() : "";
    const apiToken = await store.get(TOKEN_NAME);
    let siteUrl = "";
    if (rawSite) {
      try {
        const url = new URL(rawSite);
        if (url.protocol === "https:") siteUrl = rawSite.replace(/\/+$/, "");
      } catch {
        // Not a URL at all — treated the same as "not configured yet".
      }
    }
    return { settings, siteUrl, email, apiToken };
  }

  // A token echoed back inside an Atlassian error message must not reach a
  // response body, so every message that can be surfaced goes through here.
  function scrub(message, apiToken) {
    const text = String(message ?? "");
    return apiToken ? text.split(apiToken).join("***") : text;
  }

  async function jiraFetch(cfg, pathAndQuery, init = {}) {
    const auth = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString("base64");
    const res = await fetch(`${cfg.siteUrl}${pathAndQuery}`, {
      ...init,
      headers: {
        authorization: `Basic ${auth}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(API_TIMEOUT),
    });
    if (!res.ok) {
      // Atlassian puts the useful part in errorMessages/errors; fall back to
      // the status line when the body isn't its usual JSON. statusText is
      // empty over HTTP/2, so it is only appended when there is one — a bare
      // "404 " with a dangling space reads like a bug in the panel.
      let detail = res.statusText ? `${res.status} ${res.statusText}` : `HTTP ${res.status}`;
      try {
        const body = await res.json();
        const messages = [
          ...(Array.isArray(body?.errorMessages) ? body.errorMessages : []),
          ...(body?.errors && typeof body.errors === "object" ? Object.values(body.errors) : []),
        ].filter((m) => typeof m === "string");
        if (messages.length > 0) detail = messages.join("; ");
      } catch {
        // non-JSON error body; keep the status line
      }
      const err = new Error(scrub(detail, cfg.apiToken));
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  const myself = (cfg) => jiraFetch(cfg, "/rest/api/3/myself");

  async function search(cfg, jql, maxResults) {
    const body = await jiraFetch(cfg, "/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        maxResults,
        // priority feeds the editor tab's table; project, the group-by-project
        // headings, which want the project's name as well as its key.
        fields: ["summary", "status", "issuetype", "assignee", "priority", "project", "updated"],
      }),
    });
    const issues = Array.isArray(body?.issues) ? body.issues : [];
    return issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields?.summary ?? "",
      status: issue.fields?.status?.name ?? "",
      // "new" | "indeterminate" | "done" — the only part of a status that is
      // stable across projects, since status NAMES are per-workflow. The
      // panel colours its status chip from this.
      statusCategory: issue.fields?.status?.statusCategory?.key ?? null,
      type: issue.fields?.issuetype?.name ?? "",
      assignee: issue.fields?.assignee?.displayName ?? null,
      priority: issue.fields?.priority?.name ?? null,
      projectKey: issue.fields?.project?.key ?? null,
      projectName: issue.fields?.project?.name ?? null,
      updated: issue.fields?.updated ?? null,
      url: `${cfg.siteUrl}/browse/${issue.key}`,
    }));
  }

  function commentLimitOf(settings) {
    const raw = settings["jira.commentLimit"];
    return Number.isInteger(raw) && raw >= 0 && raw <= 100 ? raw : 20;
  }

  function maxResultsOf(settings) {
    const raw = settings["jira.maxResults"];
    return Number.isInteger(raw) && raw >= 1 && raw <= 100 ? raw : 30;
  }

  // The board's own cap: a board of 30 cards over five columns is thin. 100 is
  // also the most one /search/jql request returns.
  function boardMaxResultsOf(settings) {
    const raw = settings["jira.boardMaxResults"];
    return Number.isInteger(raw) && raw >= 1 && raw <= 100 ? raw : 100;
  }

  function boardDoneDaysOf(settings) {
    const raw = settings["jira.boardDoneDays"];
    return Number.isInteger(raw) && raw >= 0 && raw <= 90 ? raw : 14;
  }

  // ---- Worktree helpers (see this file's header) ----

  // The MAIN worktree, not `--show-toplevel`. --show-toplevel returns
  // whichever worktree cwd happens to be in, so starting work on a second
  // ticket from inside the first ticket's session would create the new
  // worktree *under* that one — and nest one level deeper every time after.
  // `git worktree list --porcelain` always emits the main worktree first.
  // Mirrors core's mainRepoRoot (server/src/gitWorktrees.ts in the main
  // perch repo), whose comment describes the same trap.
  async function repoRoot(cwd) {
    let inside;
    try {
      inside = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
    } catch {
      return null;
    }
    if (!inside) return null;
    try {
      const out = await git(["worktree", "list", "--porcelain"], inside);
      const first = out.split("\n").find((line) => line.startsWith("worktree "));
      if (first) return first.slice("worktree ".length).trim();
    } catch {
      // Unusual layout — the containing worktree is still a usable answer.
    }
    return inside;
  }

  async function gitCommonDir(cwd) {
    const raw = (await git(["rev-parse", "--git-common-dir"], cwd)).trim();
    return path.resolve(cwd, raw);
  }

  function branchSlug(branch) {
    return branch.replace(/[/\\]/g, "-");
  }

  function resolveLocation(template, repo, branch) {
    const filled = template.replaceAll("{repo}", repo).replaceAll("{branch}", branchSlug(branch));
    return path.resolve(repo, filled);
  }

  async function ensureExcluded(repo, target) {
    const rel = path.relative(repo, target);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
    const top = rel.split(path.sep)[0];
    const pattern = rel === top ? `/${top}` : `/${top}/`;
    let excludeFile;
    try {
      excludeFile = path.join(await gitCommonDir(repo), "info", "exclude");
    } catch {
      return;
    }
    let current = "";
    try {
      current = fs.readFileSync(excludeFile, "utf8");
    } catch {
      // No info/exclude yet (or unreadable) — created below.
    }
    if (current.split("\n").some((line) => line.trim() === pattern)) return;
    try {
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
      fs.appendFileSync(excludeFile, `${prefix}${pattern}\n`);
    } catch {
      // Best-effort: a read-only .git shouldn't block creating the worktree.
    }
  }

  // ---- Project key ----

  // Four sources, most local first — the in-repo file wins the way
  // .editorconfig and .nvmrc beat user-level config. Returns which source
  // answered so the panel can show it. A candidate that doesn't look like a
  // project key doesn't stop the chain; the next source gets a turn.
  async function resolveProjectKey(settings, cwd) {
    const repo = await repoRoot(cwd);

    const fileName = typeof settings["jira.projectKeyFile"] === "string" ? settings["jira.projectKeyFile"].trim() : "";
    if (repo && fileName) {
      try {
        const first = fs.readFileSync(path.join(repo, fileName), "utf8").split("\n")[0].trim();
        if (PROJECT_KEY.test(first)) return { key: first.toUpperCase(), source: "file" };
      } catch {
        // No such file in this repo — the common case, not an error.
      }
    }

    if (repo) {
      try {
        const parsed = JSON.parse(typeof settings["jira.projectMap"] === "string" ? settings["jira.projectMap"] : "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const want = repo.replace(/\/+$/, "");
          for (const [dir, key] of Object.entries(parsed)) {
            if (typeof dir === "string" && typeof key === "string" && dir.replace(/\/+$/, "") === want) {
              if (PROJECT_KEY.test(key.trim())) return { key: key.trim().toUpperCase(), source: "projectMap" };
            }
          }
        }
      } catch {
        // Malformed JSON in the setting — skipped, not thrown.
      }
    }

    const envName = typeof settings["jira.projectKeyEnv"] === "string" ? settings["jira.projectKeyEnv"].trim() : "";
    if (envName) {
      const fromEnv = (process.env[envName] ?? "").trim();
      if (PROJECT_KEY.test(fromEnv)) return { key: fromEnv.toUpperCase(), source: "env" };
    }

    const flat = typeof settings["jira.projectKey"] === "string" ? settings["jira.projectKey"].trim() : "";
    if (PROJECT_KEY.test(flat)) return { key: flat.toUpperCase(), source: "setting" };

    return { key: null, source: null };
  }

  // ---- Request guards ----

  function requireCwd(req, res) {
    const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
    if (!cwd || !path.isAbsolute(cwd)) {
      res.status(400).json({ error: "cwd must be an absolute path" });
      return null;
    }
    return cwd;
  }

  function fail(res, err, apiToken) {
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? 400 : 500;
    res.status(status).json({ error: scrub(err?.message, apiToken) });
  }

  // ---- Read endpoints ----

  // Always 200 (never 500) once cwd is valid — the panel's "not set up" states
  // read this, and an unconfigured extension is the expected first run, not an
  // error. Mirrors the github extension's /status contract.
  router.get("/status", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const cfg = await readConfig();
    const hasToken = !!cfg.apiToken;
    const configured = !!(cfg.siteUrl && cfg.email && hasToken);
    const { key, source } = await resolveProjectKey(cfg.settings, cwd);
    // The repository this folder belongs to, which the panel needs for two
    // things it can't work out for itself: the key to write a project mapping
    // under, and resolving jira.worktreeLocation's {repo} for the start
    // form's preview. It is the MAIN worktree, so both are stable however
    // deep in a worktree the active session happens to sit.
    const repo = await repoRoot(cwd);
    if (!configured) {
      res.json({ configured, hasToken, authed: false, user: null, repo, projectKey: key, projectSource: source, error: null });
      return;
    }
    try {
      const me = await myself(cfg);
      res.json({
        configured,
        hasToken,
        authed: true,
        user: { accountId: me?.accountId ?? null, displayName: me?.displayName ?? null },
        repo,
        projectKey: key,
        projectSource: source,
        error: null,
      });
    } catch (err) {
      // 404 from /myself means the URL isn't a Jira site at all, which reads
      // as a baffling "not found" unless we say which of the three settings
      // is the likely culprit. 401/403 is the token or the email.
      let message = scrub(err.message, cfg.apiToken);
      if (err.status === 404) message = `${message} - is jira.siteUrl (${cfg.siteUrl}) a Jira site?`;
      else if (err.status === 401 || err.status === 403) message = `${message} - check jira.email and your API token.`;
      res.json({
        configured,
        hasToken,
        authed: false,
        user: null,
        repo,
        projectKey: key,
        projectSource: source,
        error: message,
      });
    }
  });

  router.get("/issues", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const scope = req.query.scope;
    if (scope !== "mine" && scope !== "project") {
      res.status(400).json({ error: 'scope must be "mine" or "project"' });
      return;
    }
    const cfg = await readConfig();
    if (!cfg.siteUrl || !cfg.email || !cfg.apiToken) {
      res.status(400).json({ error: "jira is not configured" });
      return;
    }
    // `board=1` is the editor tab's board: a larger cap, and the built-in
    // queries let recently finished tickets back in. A user's own jira.jql /
    // jira.projectJql is used exactly as written - this can't safely rewrite
    // someone's query to relax its Done exclusion.
    const board = req.query.board === "1";
    const limit = board ? boardMaxResultsOf(cfg.settings) : maxResultsOf(cfg.settings);
    const days = boardDoneDaysOf(cfg.settings);
    const override = (name) => (typeof cfg.settings[name] === "string" ? cfg.settings[name].trim() : "");
    // Applied to every one of the three query paths below, including both
    // user overrides - a filter the panel is showing as active must narrow
    // whatever query the pane is actually running, not just the built-in one.
    // The sort likewise replaces whichever ORDER BY that query had.
    const filters = readFilterParams(req.query);
    const sort = readSortParams(req.query);

    try {
      if (scope === "mine") {
        const jql = override("jira.jql") || mineJql(board, days);
        res.json({
          issues: await search(cfg, composeJql(jql, filters, sort), limit),
          projectKey: null,
          projectSource: null,
        });
        return;
      }
      const customProjectJql = override("jira.projectJql");
      if (customProjectJql) {
        res.json({
          issues: await search(cfg, composeJql(customProjectJql, filters, sort), limit),
          projectKey: null,
          projectSource: "projectJql",
        });
        return;
      }
      const { key, source } = await resolveProjectKey(cfg.settings, cwd);
      if (!key) {
        res.json({ issues: [], projectKey: null, projectSource: null });
        return;
      }
      const jql = projectJql(key, board, days);
      res.json({
        issues: await search(cfg, composeJql(jql, filters, sort), limit),
        projectKey: key,
        projectSource: source,
      });
    } catch (err) {
      fail(res, err, cfg.apiToken);
    }
  });

  // The values the filter popover offers. Taken from Jira's own metadata
  // rather than from the issues currently on screen: a pane holds at most
  // jira.maxResults of them, so deriving the list from those would hide every
  // status that happens to sit further down the backlog - and then filtering
  // by it would be impossible rather than merely empty.
  //
  // Each of the four is fetched independently and swallows its own failure. A
  // site that restricts /priority should still get a working status filter,
  // and the panel simply leaves out a facet that came back empty.
  router.get("/facets", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const cfg = await readConfig();
    if (!cfg.siteUrl || !cfg.email || !cfg.apiToken) {
      res.status(400).json({ error: "jira is not configured" });
      return;
    }
    const { key } = await resolveProjectKey(cfg.settings, cwd);

    // One call answers both statuses and types, and answers them for the
    // project's actual workflow. The site-wide lists further down are the
    // fallback for the "assigned to me" pane, which spans every project and
    // so has no single workflow to ask.
    let statuses = [];
    let types = [];
    if (key) {
      try {
        const body = await jiraFetch(cfg, `/rest/api/3/project/${encodeURIComponent(key)}/statuses`);
        const entries = Array.isArray(body) ? body : [];
        types = uniqueByName(entries.map((t) => ({ name: typeof t?.name === "string" ? t.name : "" })));
        statuses = uniqueByName(
          entries.flatMap((t) =>
            (Array.isArray(t?.statuses) ? t.statuses : []).map((s) => ({
              name: typeof s?.name === "string" ? s.name : "",
              category: s?.statusCategory?.key ?? null,
            })),
          ),
        );
      } catch {
        // Left empty so the site-wide lists below answer instead.
      }
    }
    if (statuses.length === 0) {
      try {
        const body = await jiraFetch(cfg, "/rest/api/3/status");
        statuses = uniqueByName(
          (Array.isArray(body) ? body : []).map((s) => ({
            name: typeof s?.name === "string" ? s.name : "",
            category: s?.statusCategory?.key ?? null,
          })),
        );
      } catch {
        statuses = [];
      }
    }
    if (types.length === 0) {
      try {
        const body = await jiraFetch(cfg, "/rest/api/3/issuetype");
        types = uniqueByName((Array.isArray(body) ? body : []).map((t) => ({ name: typeof t?.name === "string" ? t.name : "" })));
      } catch {
        types = [];
      }
    }

    // Only a project can answer "who could this be assigned to". The
    // "assigned to me" pane is one person by definition and hides this facet.
    let assignees = [];
    if (key) {
      try {
        const body = await jiraFetch(
          cfg,
          `/rest/api/3/user/assignable/search?project=${encodeURIComponent(key)}&maxResults=50`,
        );
        assignees = (Array.isArray(body) ? body : [])
          .filter((u) => typeof u?.accountId === "string")
          .map((u) => ({ accountId: u.accountId, displayName: u.displayName ?? u.accountId }));
      } catch {
        assignees = [];
      }
    }

    let priorities = [];
    try {
      const body = await jiraFetch(cfg, "/rest/api/3/priority");
      priorities = uniqueByName((Array.isArray(body) ? body : []).map((p) => ({ name: typeof p?.name === "string" ? p.name : "" })));
    } catch {
      priorities = [];
    }

    res.json({ statuses, assignees, types, priorities });
  });

  // Every checkout of the active repo, for "Add to worktree". Served here
  // rather than read from core's /api/git/worktrees so both path conventions
  // come back together - see shortenHome's comment.
  router.get("/worktrees", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const repo = await repoRoot(cwd);
    if (!repo) {
      res.status(400).json({ error: `${cwd} is not inside a git repository` });
      return;
    }
    try {
      const out = await git(["worktree", "list", "--porcelain"], repo);
      // `git worktree list` always emits the main worktree first - the same
      // ordering repoRoot() above relies on.
      res.json({
        worktrees: parseWorktreeList(out).map((wt, i) => ({
          ...wt,
          displayPath: shortenHome(wt.path),
          main: i === 0,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The site's projects, for the project picker. No cwd: the list is the same
  // whichever repo you are looking at - it is the mapping that is per-repo.
  router.get("/projects", async (_req, res) => {
    const cfg = await readConfig();
    if (!cfg.siteUrl || !cfg.email || !cfg.apiToken) {
      res.status(400).json({ error: "jira is not configured" });
      return;
    }
    try {
      const projects = [];
      for (let startAt = 0; startAt < PROJECT_CAP; startAt += PROJECT_PAGE) {
        const body = await jiraFetch(
          cfg,
          `/rest/api/3/project/search?maxResults=${PROJECT_PAGE}&startAt=${startAt}&orderBy=key`,
        );
        const values = Array.isArray(body?.values) ? body.values : [];
        for (const p of values) {
          if (typeof p?.key === "string") projects.push({ key: p.key, name: typeof p.name === "string" ? p.name : p.key });
        }
        // `isLast` is the documented end marker; the length check is the
        // backstop for a site that omits it, so this can't spin.
        if (body?.isLast !== false || values.length === 0) break;
      }
      res.json({ projects });
    } catch (err) {
      fail(res, err, cfg.apiToken);
    }
  });

  // One ticket, in full. Its own function because three callers want the same
  // object: the route below, the brief an agent is handed, and the prompt the
  // clustering AI reads. A second shape for any of them would be a second
  // thing to keep in step with Jira's field names.
  async function issueDetail(cfg, key) {
      const issue = await jiraFetch(
        cfg,
        `/rest/api/3/issue/${key}?fields=summary,description,status,issuetype,priority,labels,components,parent,assignee,reporter,created,updated`,
      );

      // Comments are where the actual decisions usually live - the
      // description is often a one-liner and everything that matters was
      // hashed out in the thread. Fetched separately because the issue
      // endpoint's own `comment` field is paginated and capped independently.
      // 0 disables; failure is non-fatal, since a usable description beats no
      // context at all.
      const limit = commentLimitOf(cfg.settings);
      let comments = [];
      if (limit > 0) {
        try {
          const body = await jiraFetch(
            cfg,
            `/rest/api/3/issue/${key}/comment?orderBy=-created&maxResults=${limit}`,
          );
          comments = (Array.isArray(body?.comments) ? body.comments : [])
            .map((c) => ({
              author: c.author?.displayName ?? "Unknown",
              created: c.created ?? null,
              body: adfToMarkdown(c.body),
            }))
            .filter((c) => c.body)
            // orderBy=-created gives newest first; reverse so the agent reads
            // the thread in the order it happened.
            .reverse();
        } catch {
          // Left empty — the description alone is still worth handing over.
        }
      }

    const parent = issue.fields?.parent;
    return {
      key: issue.key,
      summary: issue.fields?.summary ?? "",
      description: adfToMarkdown(issue.fields?.description),
      status: issue.fields?.status?.name ?? "",
      // The status chip is coloured by category - the only part of a status
      // that means the same thing across workflows.
      statusCategory: issue.fields?.status?.statusCategory?.key ?? null,
      type: issue.fields?.issuetype?.name ?? "",
      priority: issue.fields?.priority?.name ?? null,
      labels: Array.isArray(issue.fields?.labels) ? issue.fields.labels : [],
      // Components and the epic are what the no-AI grouping falls back to,
      // and what the clustering prompt leans on when the descriptions are
      // thin. They cost nothing on a request that is already being made.
      components: Array.isArray(issue.fields?.components)
        ? issue.fields.components.map((c) => (typeof c?.name === "string" ? c.name : "")).filter(Boolean)
        : [],
      parent: parent?.key ? { key: parent.key, summary: parent.fields?.summary ?? "" } : null,
      assignee: issue.fields?.assignee?.displayName ?? null,
      reporter: issue.fields?.reporter?.displayName ?? null,
      created: issue.fields?.created ?? null,
      updated: issue.fields?.updated ?? null,
      comments,
      url: `${cfg.siteUrl}/browse/${issue.key}`,
    };
  }

  // Several tickets at once, by key: what a pasted list resolves through, and
  // how a batch reloads the rows it was planned from. Chunked, because one
  // `key in (...)` naming two hundred tickets is a query Jira will refuse.
  // Keys nobody can see come back as `missing` rather than as an error - a
  // typo in a pasted list should cost that line, not the whole paste.
  async function issuesByKeys(cfg, keys) {
    const wanted = [...new Set(keys.map((key) => key.toUpperCase()))];
    const found = [];
    for (let i = 0; i < wanted.length; i += KEY_CHUNK) {
      const chunk = wanted.slice(i, i + KEY_CHUNK);
      const jql = `key in (${chunk.map((key) => escapeJql(key)).join(", ")})`;
      found.push(...(await search(cfg, jql, chunk.length)));
    }
    const seen = new Set(found.map((issue) => issue.key.toUpperCase()));
    return { found, missing: wanted.filter((key) => !seen.has(key)) };
  }

  // A pasted list of tickets, resolved. What the user types is whatever they
  // had to hand - keys from a chat message, a whole browse URL, lowercase,
  // separated by commas or newlines - so the splitting is deliberately loose
  // and the reporting is precise: every entry comes back as found, missing or
  // invalid, by name, and nothing is silently dropped.
  router.post(
    "/issues/lookup",
    route(async (req, res) => {
      const raw = req.body?.keys;
      if (!Array.isArray(raw) && typeof raw !== "string") throw bad("keys must be a string or an array of strings");
      const entries = (Array.isArray(raw) ? raw : [raw])
        .filter((entry) => typeof entry === "string")
        .flatMap((entry) => entry.split(/[\s,;]+/))
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (entries.length > 200) throw bad("that is more than 200 tickets - paste fewer");

      const invalid = [];
      const keys = [];
      for (const entry of entries) {
        // A browse URL ends in the key; anything else has to BE one.
        const fromUrl = entry.match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)\/?$/);
        const candidate = fromUrl ? fromUrl[1] : entry;
        if (ISSUE_KEY.test(candidate)) keys.push(candidate.toUpperCase());
        else invalid.push(entry);
      }

      const cfg = await readConfig();
      if (!cfg.siteUrl || !cfg.email || !cfg.apiToken) throw bad("jira is not configured");
      if (keys.length === 0) {
        res.json({ found: [], missing: [], invalid });
        return;
      }
      try {
        const { found, missing } = await issuesByKeys(cfg, keys);
        res.json({ found, missing, invalid });
      } catch (err) {
        fail(res, err, cfg.apiToken);
      }
    }),
  );

  router.get("/issue", async (req, res) => {
    const key = typeof req.query.key === "string" ? req.query.key : "";
    if (!ISSUE_KEY.test(key)) {
      res.status(400).json({ error: "key must be an issue key like CAP-123" });
      return;
    }
    const cfg = await readConfig();
    if (!cfg.siteUrl || !cfg.email || !cfg.apiToken) {
      res.status(400).json({ error: "jira is not configured" });
      return;
    }
    try {
      res.json(await issueDetail(cfg, key));
    } catch (err) {
      fail(res, err, cfg.apiToken);
    }
  });

  // ---- Token routes ----
  //
  // Presence only, never the value — the same contract core's own
  // GET /api/ai-key uses. Core serves no route for extension secrets by
  // design; this is the extension's own.

  router.get("/token", async (_req, res) => {
    // `supported: false` lets the panel say why the field is unusable instead
    // of showing it as merely not configured yet.
    try {
      res.json({ set: !!(await store.get(TOKEN_NAME)), supported: secretsAvailable });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put("/token", async (req, res) => {
    const value = req.body?.value;
    if (typeof value !== "string") {
      res.status(400).json({ error: "value must be a string" });
      return;
    }
    if (!secretsAvailable) {
      res.status(501).json({ error: NO_SECRETS });
      return;
    }
    try {
      await store.set(TOKEN_NAME, value.trim() || null);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Write endpoints ----

  // The repo's default branch, so a worktree starts from it rather than from
  // whatever happened to be checked out. origin/HEAD is often simply absent
  // (a --depth clone, or an origin added by hand), so this falls back through
  // `git remote show` to the current HEAD, reporting which it used.
  // What origin/HEAD says without asking origin. Nothing here leaves the
  // machine, so it is safe on a repo with no remote, an unreachable one, or
  // one whose credentials would prompt.
  async function localDefaultBranch(repo) {
    try {
      const ref = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo)).trim();
      if (ref) return { base: ref, note: null };
    } catch {
      // Not set locally, which is not worth a note here: branching from HEAD
      // is what someone starting a cluster on their current work expects.
    }
    return { base: null, note: null };
  }

  async function defaultBranch(repo) {
    try {
      const ref = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo)).trim();
      if (ref) return { base: ref, note: null };
    } catch {
      // Fall through — not set locally.
    }
    try {
      const out = await git(["remote", "show", "origin"], repo, FETCH_TIMEOUT);
      const match = out.match(/HEAD branch:\s*(\S+)/);
      if (match && match[1] !== "(unknown)") return { base: `origin/${match[1]}`, note: null };
    } catch {
      // No origin, or it is unreachable.
    }
    return {
      base: null,
      note: "Could not determine the default branch (no origin/HEAD) - branched from the current HEAD instead. `git remote set-head origin -a` fixes this.",
    };
  }

  // A worktree on a new branch off the repo's default branch. Its own
  // function because a batch creates one per cluster from the server, with no
  // browser in the loop, and must land in exactly the same place with exactly
  // the same refusals as the button does.
  //
  // `offline` is the one deliberate difference, and it is about how much
  // network to attempt, never about whether the worktree gets made. "Start
  // work" is a single worktree, so it is worth a moment's wait to fetch and
  // branch off something current. A batch is N worktrees in a row: that is N
  // fetches of the same repository and N chances to sit on a timeout or a
  // credential prompt, for a base that the first one already brought up to
  // date.
  //
  // Neither mode lets the remote decide whether the worktree happens. See the
  // fetch below.
  async function createWorktree(cwd, branch, settings, { offline = false } = {}) {
    const name = branch.trim();
    const repo = await repoRoot(cwd);
    if (!repo) throw bad(`${cwd} is not inside a git repository`);
    const template =
      typeof settings["jira.worktreeLocation"] === "string" && settings["jira.worktreeLocation"].trim()
        ? settings["jira.worktreeLocation"].trim()
        : "{repo}/.worktrees/{branch}";
    const target = resolveLocation(template, repo, name);
    if (fs.existsSync(target)) throw conflict(`${target} already exists`);

    // Offline: whatever origin/HEAD already says locally, and HEAD when it
    // says nothing - `git remote show origin`, the other branch of
    // defaultBranch, goes to the network too.
    const { base, note } = offline ? await localDefaultBranch(repo) : await defaultBranch(repo);
    const notes = note ? [note] : [];
    if (base && !offline) {
      try {
        await git(["fetch", "origin"], repo, FETCH_TIMEOUT);
      } catch (err) {
        // Best effort, not a precondition. A host that cannot reach the remote
        // - no key deployed for it, no network, a credential prompt sitting
        // behind the timeout - still has a perfectly serviceable local base,
        // and refusing the worktree over a possibly stale one left "Start
        // work" dead on exactly the machines this runs on.
        //
        // Branching off a stale base silently is still worse than saying so,
        // so it is said: the same note channel the panel already shows for a
        // fallback base, and the same bargain progressIssue makes when Jira
        // will not answer.
        notes.push(`Branched off ${base} as it stands locally - git fetch origin failed: ${firstLine(err.message)}`);
      }
    }

    await ensureExcluded(repo, target);
    const args = ["worktree", "add", "-b", name, target];
    if (base) args.push(base);
    try {
      await git(args, repo);
    } catch (err) {
      // `git worktree add -b` fails this way when the branch is taken, which
      // the panel must be able to tell apart from a real git failure: one is
      // "pick another name", the other is not.
      if (/already exists/i.test(err.message)) throw conflict(err.message);
      throw new HttpError(500, err.message);
    }
    return { path: target, branch: name, base: base ?? "HEAD", note: notes.join(" ") || null };
  }

  router.post("/worktree", async (req, res) => {
    const { cwd, branch } = req.body ?? {};
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || typeof branch !== "string" || !branch.trim()) {
      res.status(400).json({ error: "cwd (absolute path) and branch are required" });
      return;
    }
    try {
      res.json(await createWorktree(cwd, branch, await getSettings()));
    } catch (err) {
      res.status(typeof err?.status === "number" ? err.status : 500).json({ error: err.message });
    }
  });

  // Always 200, even when a step fails: the worktree already exists by the
  // time this runs, so a 500 here would read as "Start work failed" for
  // something that only affects the Jira side. The reason travels in `note`.
  async function progressIssue(cfg, key) {
    if (!cfg.siteUrl || !cfg.email || !cfg.apiToken) {
      return { transitioned: false, assigned: false, note: "Jira is not configured." };
    }
    const wanted =
      typeof cfg.settings["jira.inProgressStatus"] === "string" && cfg.settings["jira.inProgressStatus"].trim()
        ? cfg.settings["jira.inProgressStatus"].trim()
        : "In Progress";

    let transitioned = false;
    let assigned = false;
    const notes = [];

    try {
      const body = await jiraFetch(cfg, `/rest/api/3/issue/${key}/transitions`);
      const transitions = Array.isArray(body?.transitions) ? body.transitions : [];
      const match =
        transitions.find((t) => typeof t?.to?.name === "string" && t.to.name.toLowerCase() === wanted.toLowerCase()) ??
        transitions.find((t) => t?.to?.statusCategory?.key === "indeterminate");
      if (match) {
        await jiraFetch(cfg, `/rest/api/3/issue/${key}/transitions`, {
          method: "POST",
          body: JSON.stringify({ transition: { id: match.id } }),
        });
        transitioned = true;
      } else {
        notes.push(`No transition to "${wanted}" is available from this issue's current status.`);
      }
    } catch (err) {
      notes.push(`Could not transition the issue: ${scrub(err.message, cfg.apiToken)}`);
    }

    try {
      const issue = await jiraFetch(cfg, `/rest/api/3/issue/${key}?fields=assignee`);
      if (issue?.fields?.assignee) {
        notes.push(`Already assigned to ${issue.fields.assignee.displayName ?? "someone else"}, left as is.`);
      } else {
        const me = await myself(cfg);
        await jiraFetch(cfg, `/rest/api/3/issue/${key}/assignee`, {
          method: "PUT",
          body: JSON.stringify({ accountId: me.accountId }),
        });
        assigned = true;
      }
    } catch (err) {
      notes.push(`Could not assign the issue: ${scrub(err.message, cfg.apiToken)}`);
    }

    return { transitioned, assigned, note: notes.length > 0 ? notes.join(" ") : null };
  }

  router.post("/progress", async (req, res) => {
    const key = req.body?.key;
    if (typeof key !== "string" || !ISSUE_KEY.test(key)) {
      res.status(400).json({ error: "key must be an issue key like CAP-123" });
      return;
    }
    res.json(await progressIssue(await readConfig(), key));
  });

  // ---- Batches ----
  //
  // Planning, starting and supervising several clusters of tickets. The state
  // lives in batchStore (on disk, outliving every browser); the rules live in
  // batchModel (pure, tested); anything that touches a terminal lives in
  // batchRunner. What is left here is the HTTP shape of it.

  // `store` above is the secret store; this one holds the batches.
  const batches = createBatchStore(configDir);
  const runner = createBatchRunner({
    host,
    getSettings,
    store: batches,
    readConfig,
    issueDetail,
    createWorktree,
    progressIssue,
    configDir,
    log,
  });
  runner.start().catch((err) => log(`could not start the batch runner: ${err?.stack ?? err}`));
  activeRunner = runner;

  // Open boards, and the store change that feeds them. One event per changed
  // batch, carrying only its id: the client refetches that batch, which
  // cannot drift the way a stream of diffs can.
  const boards = new Set();
  batches.onChange((before, after) => {
    for (const event of diffEvents(before, after)) {
      const line = `event: batch-changed\ndata: ${JSON.stringify(event)}\n\n`;
      for (const res of boards) {
        try {
          res.write(line);
        } catch {
          boards.delete(res);
        }
      }
    }
  });
  openBoards = boards;

  router.get(
    "/batches/events",
    route(async (req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Nothing between here and the browser should buffer a stream whose
        // whole point is arriving promptly.
        "x-accel-buffering": "no",
      });
      res.flushHeaders?.();
      res.write(": open\n\n");
      boards.add(res);
      // A proxy that drops an idle connection would leave the board quietly
      // out of date; a comment every 25s is cheaper than finding out.
      const ping = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(ping);
        }
      }, 25_000);
      ping.unref?.();
      req.on("close", () => {
        clearInterval(ping);
        boards.delete(res);
      });
    }),
  );

  // The repository a batch belongs to. `cwd` can arrive "~"-shortened, which
  // the client displays and core hands back, so it is expanded before any of
  // it reaches the filesystem.
  async function repoOf(req) {
    const raw = typeof req.query.cwd === "string" ? req.query.cwd : req.body?.cwd;
    if (typeof raw !== "string" || !raw) throw bad("cwd is required");
    const cwd = raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw;
    if (!path.isAbsolute(cwd)) throw bad("cwd must be an absolute path");
    const repo = await repoRoot(cwd);
    if (!repo) throw bad(`${cwd} is not inside a git repository`);
    return repo;
  }

  function batchOr404(doc, id) {
    const batch = doc.batches[id];
    if (!batch) throw notFound(`no batch ${id}`);
    return batch;
  }

  // What a batch looks like to the client: the model's derived answers baked
  // in, so the board never re-implements a rule the server already decided.
  function decorate(batch) {
    return {
      ...batch,
      clusters: batch.clusters.map((cluster) => ({
        ...cluster,
        state: clusterState(batch, cluster),
        storedState: cluster.state,
        actions: allowedClusterActions(batch, cluster),
        working: activeKey(batch, cluster),
      })),
      counts: ticketCounts(batch),
      pendingFeedback: pendingFeedbackCount(batch),
      canArchive: canArchive(batch),
      canDelete: canDelete(batch),
    };
  }

  function summarize(batch) {
    return {
      id: batch.id,
      name: batch.name,
      repo: batch.repo,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      archivedAt: batch.archivedAt,
      counts: ticketCounts(batch),
      clusters: batch.clusters.map((cluster) => ({ id: cluster.id, name: cluster.name, color: cluster.color, state: clusterState(batch, cluster) })),
      pendingFeedback: pendingFeedbackCount(batch),
    };
  }

  router.get(
    "/batches",
    route(async (req, res) => {
      const repo = await repoOf(req);
      const doc = await batches.get();
      const mine = Object.values(doc.batches).filter((batch) => batch.repo === repo);
      mine.sort((a, b) => b.createdAt - a.createdAt);
      res.json({
        batches: mine.filter((batch) => !batch.archivedAt).map(summarize),
        archived: mine.filter((batch) => batch.archivedAt).map(summarize),
      });
    }),
  );

  // A ticket's stored screenshot. Served from the extension's own store, not
  // from the worktree, so it survives the worktree being removed.
  //
  // No user string reaches the filesystem: the key is matched against the
  // batch's own ticket list and `which` against two literals, so a traversal
  // attempt is a 400 about an unknown ticket rather than a path that gets
  // built and then checked.
  router.get(
    "/qa/:batchId/:key/:which",
    route(async (req, res) => {
      const { batchId, key, which } = req.params;
      // before, after, or one of the extra shots by position. Matched against
      // a pattern rather than passed through, because this becomes a path
      // segment: anything that is not one of these three shapes must not
      // reach the filesystem.
      const extra = /^shot-([1-9][0-9]?)$/.exec(which);
      if (which !== "before" && which !== "after" && !extra) {
        throw bad("which must be before, after, or shot-<n>");
      }
      if (!ISSUE_KEY.test(key)) throw bad("key must be an issue key like CAP-123");
      const doc = await batches.get();
      const batch = batchOr404(doc, batchId);
      const upper = key.toUpperCase();
      const qa = batch.ticketStates[upper]?.qa;
      const shot = extra ? (qa?.shots ?? []).find((entry) => entry.label === which) : qa?.[which];
      if (!shot) throw notFound(`no ${which} image for ${upper}`);

      const file = path.join(runner.evidenceDir, batchId, upper, `${which}.${shot.ext}`);
      const type = shot.ext === "png" ? "image/png" : shot.ext === "webp" ? "image/webp" : "image/jpeg";
      res.setHeader("content-type", type);
      // The bytes for one report can be replaced when a ticket is re-QA'd
      // after rework, and a cached older shot beside a newer verdict would be
      // evidence for the wrong pass.
      res.setHeader("cache-control", "no-store");
      res.sendFile(file, (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "that image is no longer stored" });
      });
    }),
  );

  router.get(
    "/batches/badge",
    route(async (_req, res) => {
      res.json({ badge: badgeCount(await batches.get()) });
    }),
  );

  router.get(
    "/batches/:id",
    route(async (req, res) => {
      const doc = await batches.get();
      res.json({ batch: decorate(batchOr404(doc, req.params.id)) });
    }),
  );

  // What the skill pickers offer. The extension locates skills and reports
  // what it found; it never reads one - whatever a chosen skill says is what
  // the agent does.
  router.get(
    "/skills",
    route(async (req, res) => {
      const raw = typeof req.query.cwd === "string" ? req.query.cwd : "";
      let repo = null;
      if (raw) {
        const cwd = raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw;
        repo = await repoRoot(cwd);
      }
      const settings = await getSettings();
      const skills = await discoverSkills({ repo, extraPaths: parseSkillPaths(settings["jira.skillPaths"]) });
      res.json({
        skills: skills.map(({ dir, name, description, origin }) => ({ dir, name, description, origin })),
        // Named so the picker can label its Default entry with what would
        // actually answer, rather than the word "default" alone. Plain names:
        // the label goes inside "Default (...)", so anything parenthesised
        // here nests a second bracket and overflows the select.
        defaults: { execution: "execute-jira-ticket", qa: "jira-batch-qa" },
      });
    }),
  );

  // Adopting the bundled QA skill: a copy into the user's own skills
  // directory, which the picker then lists like any other. `force` is the
  // caller's answer to "there is already one of those" - the route never
  // decides that for them.
  router.post(
    "/skills/install-qa",
    route(async (req, res) => {
      const force = req.body?.force === true;
      const result = await runner.installQaSkillForUser({ force });
      res.json(result);
    }),
  );

  // The AI profiles, for the form's "Read the codebase" choice: only a CLI
  // agent can read files, and a keyed API silently cannot, so the checkbox
  // has to know which one answers.
  router.get(
    "/ai-profiles",
    route(async (_req, res) => {
      if (!ai?.listProfiles) {
        res.json({ profiles: [], supported: false });
        return;
      }
      try {
        res.json({ profiles: await ai.listProfiles(), supported: true });
      } catch (err) {
        res.json({ profiles: [], supported: false, error: err?.message ?? String(err) });
      }
    }),
  );

  // Plan a batch, or place new tickets in one that exists. One AI call either
  // way; the difference is what the prompt is told and what the proposal is
  // allowed to move.
  router.post(
    "/batches/analyze",
    route(async (req, res) => {
      const repo = await repoOf(req);
      const body = req.body ?? {};
      const criteria = typeof body.criteria === "string" ? body.criteria : "";
      // Split by hand: no AI call, everything in one cluster. The criteria
      // and the codebase read only exist to inform a model, so neither
      // applies.
      const single = body.single === true;
      const readCodebase = !single && body.readCodebase === true;
      const keys = (Array.isArray(body.keys) ? body.keys : []).filter((key) => typeof key === "string" && ISSUE_KEY.test(key)).map((key) => key.toUpperCase());
      if (keys.length === 0) throw bad("no tickets to analyze");

      const cfg = await readConfig();
      if (!cfg.siteUrl || !cfg.email || !cfg.apiToken) throw bad("jira is not configured");

      const existingBatchId = typeof body.batchId === "string" && body.batchId ? body.batchId : null;
      let doc = await batches.get();
      const target = existingBatchId ? batchOr404(doc, existingBatchId) : null;
      const fresh = target ? keys.filter((key) => !target.tickets[key]) : keys;
      if (target && fresh.length === 0) throw bad("every one of those tickets is already in this batch");

      const details = [];
      for (const key of fresh) details.push(await issueDetail(cfg, key));

      const existing = target
        ? target.clusters
            .filter((cluster) => OPEN_FOR_ADD.has(clusterState(target, cluster)))
            .map((cluster) => ({ id: cluster.id, name: cluster.name, state: clusterState(target, cluster), keys: cluster.keys, rationale: cluster.rationale }))
        : [];

      const profiles = single ? [] : ai?.listProfiles ? await ai.listProfiles().catch(() => []) : [];
      let proposal;
      let warnings = [];
      let heuristic = false;
      if (single) {
        proposal = singleCluster(details);
      } else if (profiles.length === 0) {
        // No AI at all is not an error: the fields a team already fills in
        // are a worse grouping than a model's, and a far better one than none.
        proposal = heuristicClusters(details);
        heuristic = true;
      } else {
        const prompt = buildClusterPrompt({ criteria, readCodebase, repo, tickets: details, existing });
        const settings = await getSettings();
        const seconds = Number(settings["jira.batchAnalysisTimeoutSeconds"]);
        const timeoutMs = readCodebase ? Math.min(900, Math.max(60, Number.isFinite(seconds) ? seconds : 600)) * 1000 : undefined;
        let reply;
        try {
          reply = await ai.run(prompt, { cwd: readCodebase ? repo : undefined, timeoutMs });
        } catch (err) {
          const message = err?.message ?? String(err);
          // A core without timeoutMs ends a codebase read at its own 60s, and
          // the only honest thing to say is which limit was hit and what to
          // do instead - not "the AI failed".
          if (readCodebase && /timed out after 60s/.test(message)) {
            throw new HttpError(422, "Codebase-aware analysis needs a newer Perch - its AI calls stop after 60 seconds. Analyze without reading the codebase, or update Perch.");
          }
          if (readCodebase && /timed out/.test(message)) {
            throw new HttpError(422, `${message}. Analyze without reading the codebase, or raise jira.batchAnalysisTimeoutSeconds.`);
          }
          throw new HttpError(502, message);
        }
        const parsed = parseClusterReply(reply, { allowedKeys: fresh, existing });
        if (!parsed.ok) throw new HttpError(422, parsed.error);
        proposal = parsed.proposal;
        warnings = parsed.warnings;
      }

      const now = Date.now();
      const result = await batches.update((draft) => {
        if (target) {
          const batch = draft.batches[existingBatchId];
          for (const detail of details) batch.tickets[detail.key] = newTicket(detail);
          batch.unclustered.push(...fresh.filter((key) => !batch.unclustered.includes(key)));
          batch.pendingProposal = { ...proposal, keys: fresh, heuristic, warnings };
          batch.updatedAt = now;
          return { batchId: batch.id };
        }
        const id = newId("bat");
        const name = proposal.clusters[0]?.name
          ? `${proposal.clusters[0].name}${proposal.clusters.length > 1 ? ` +${proposal.clusters.length - 1}` : ""}`
          : "Batch";
        const batch = newBatch({ id, name, repo, criteria: single ? "" : criteria, readCodebase, tickets: details, now });
        const applied = applyProposal(batch, proposal, { makeId: () => newId("cls"), now });
        warnings = [...warnings, ...applied.warnings];
        draft.batches[id] = batch;
        return { batchId: id };
      });

      const after = await batches.get();
      res.json({
        batchId: result.batchId,
        batch: decorate(after.batches[result.batchId]),
        warnings,
        heuristic,
        addOnly: Boolean(target),
      });
    }),
  );

  // Apply the pending add-only proposal, then hand the new tickets to the
  // agents that are already running.
  router.post(
    "/batches/:id/apply",
    route(async (req, res) => {
      const id = req.params.id;
      const before = await batches.get();
      const batch = batchOr404(before, id);
      if (!batch.pendingProposal) throw bad("there is nothing to apply");

      const outcome = await batches.update((draft) => {
        const target = draft.batches[id];
        const proposal = req.body?.proposal ?? target.pendingProposal;
        const applied = applyProposal(target, proposal, { addOnly: true, makeId: () => newId("cls"), now: Date.now() });
        target.pendingProposal = null;
        return applied;
      });

      // Only clusters with a live agent need telling; a pending one will
      // carry its new tickets into its own launch brief.
      const after = await batches.get();
      const target = after.batches[id];
      const handovers = [];
      for (const cluster of target.clusters) {
        const keys = cluster.keys.filter((key) => outcome.placed.includes(key) && target.ticketStates[key] === undefined);
        if (keys.length === 0 || !cluster.windowId) continue;
        try {
          await runner.handOffAdditional(id, cluster.id, keys);
          await batches.update((draft) => {
            const fresh = draft.batches[id];
            const live = fresh.clusters.find((c) => c.id === cluster.id);
            for (const key of keys) {
              if (!fresh.ticketStates[key]) {
                fresh.ticketStates[key] = { state: "queued", clusterId: live.id, since: Date.now(), history: [{ state: "queued", at: Date.now(), note: "added to a running cluster" }], summary: "", reason: "", feedbackDraft: "", feedback: [] };
              }
            }
            fresh.unclustered = fresh.unclustered.filter((key) => !keys.includes(key));
            return { ok: true };
          });
          handovers.push({ clusterId: cluster.id, keys });
        } catch (err) {
          outcome.warnings.push(`Could not hand ${keys.join(", ")} to "${cluster.name}": ${err.message}`);
        }
      }

      const finished = await batches.get();
      res.json({ batch: decorate(finished.batches[id]), warnings: outcome.warnings, handovers });
    }),
  );

  // Review-time edits: the whole cluster layout, replaced.
  router.post(
    "/batches/:id/clusters",
    route(async (req, res) => {
      const id = req.params.id;
      const proposal = req.body?.proposal;
      if (!proposal || typeof proposal !== "object") throw bad("a proposal is required");
      const outcome = await batches.update((draft) => {
        const batch = batchOr404(draft, id);
        return applyProposal(batch, proposal, { makeId: () => newId("cls"), now: Date.now() });
      });
      const doc = await batches.get();
      res.json({ batch: decorate(doc.batches[id]), warnings: outcome.warnings });
    }),
  );

  router.post(
    "/batches/:id/rename",
    route(async (req, res) => {
      const result = await batches.update((draft) => renameBatch(batchOr404(draft, req.params.id), req.body?.name ?? "", Date.now()));
      if (!result.ok) throw bad(result.error);
      res.json({ batch: decorate((await batches.get()).batches[req.params.id]) });
    }),
  );

  router.post(
    "/batches/:id/clusters/:cid/rename",
    route(async (req, res) => {
      const result = await batches.update((draft) => renameCluster(batchOr404(draft, req.params.id), req.params.cid, req.body?.name ?? "", Date.now()));
      if (!result.ok) throw conflict(result.error);
      res.json({ batch: decorate((await batches.get()).batches[req.params.id]) });
    }),
  );

  router.post(
    "/batches/:id/clusters/:cid/branch",
    route(async (req, res) => {
      const result = await batches.update((draft) => setBranch(batchOr404(draft, req.params.id), req.params.cid, req.body?.branch ?? "", Date.now()));
      if (!result.ok) throw conflict(result.error);
      res.json({ batch: decorate((await batches.get()).batches[req.params.id]) });
    }),
  );

  router.post(
    "/batches/:id/clusters/add",
    route(async (req, res) => {
      await batches.update((draft) => addCluster(batchOr404(draft, req.params.id), { id: newId("cls"), name: req.body?.name ?? "", now: Date.now() }));
      res.json({ batch: decorate((await batches.get()).batches[req.params.id]) });
    }),
  );

  router.post(
    "/batches/:id/clusters/:cid/remove",
    route(async (req, res) => {
      const result = await batches.update((draft) => removeCluster(batchOr404(draft, req.params.id), req.params.cid, Date.now()));
      if (!result.ok) throw conflict(result.error);
      res.json({ batch: decorate((await batches.get()).batches[req.params.id]) });
    }),
  );

  router.post(
    "/batches/:id/move",
    route(async (req, res) => {
      const { key, clusterId, index } = req.body ?? {};
      if (typeof key !== "string") throw bad("key is required");
      const result = await batches.update((draft) =>
        moveTicket(batchOr404(draft, req.params.id), key.toUpperCase(), typeof clusterId === "string" ? clusterId : null, index, Date.now()),
      );
      if (!result.ok) throw conflict(result.error);
      res.json({ batch: decorate((await batches.get()).batches[req.params.id]) });
    }),
  );

  router.post(
    "/batches/:id/start",
    route(async (req, res) => {
      const id = req.params.id;
      const body = req.body ?? {};
      const clusterIds = (Array.isArray(body.clusterIds) ? body.clusterIds : []).filter((entry) => typeof entry === "string");
      const agentId = typeof body.agentId === "string" ? body.agentId : "";
      if (clusterIds.length === 0) throw bad("no clusters to start");
      if (!agentId) throw bad("an agent is required");
      const branches = body.branches && typeof body.branches === "object" ? body.branches : {};
      // A per-cluster override of the Settings choice, for this run only.
      const skills = body.skills && typeof body.skills === "object" ? body.skills : {};
      const outcome = await runner.startClusters(id, clusterIds, agentId, branches, {
        execution: typeof skills.execution === "string" ? skills.execution : undefined,
        qa: typeof skills.qa === "string" ? skills.qa : undefined,
      });
      await batches.update((draft) => {
        draft.batches[id].agentId = agentId;
        return { ok: true };
      });
      const doc = await batches.get();
      res.json({ batch: decorate(batchOr404(doc, id)), ...outcome });
    }),
  );

  const clusterAction = (name, run) =>
    router.post(
      `/batches/:id/clusters/:cid/${name}`,
      route(async (req, res) => {
        const result = await run(req);
        const doc = await batches.get();
        res.json({ batch: decorate(batchOr404(doc, req.params.id)), result });
      }),
    );

  router.post(
    "/batches/:id/clusters/:cid/rebuild-report",
    route(async (req, res) => {
      const result = await runner.buildClusterReport(req.params.id, req.params.cid);
      const doc = await batches.get();
      res.json({ batch: decorate(batchOr404(doc, req.params.id)), result });
    }),
  );

  clusterAction("stop", (req) => runner.stopCluster(req.params.id, req.params.cid));
  clusterAction("resume", (req) => runner.resume(req.params.id, req.params.cid));
  clusterAction("close", (req) => runner.closeCluster(req.params.id, req.params.cid));
  clusterAction("remove-worktree", (req) => runner.removeWorktree(req.params.id, req.params.cid, req.body?.force === true));

  router.post(
    "/batches/:id/tickets/:key/feedback",
    route(async (req, res) => {
      const result = await batches.update((draft) =>
        setFeedbackDraft(batchOr404(draft, req.params.id), req.params.key.toUpperCase(), req.body?.text ?? "", Date.now()),
      );
      if (!result.ok) throw conflict(result.error);
      res.json({ batch: decorate((await batches.get()).batches[req.params.id]) });
    }),
  );

  router.post(
    "/batches/:id/tickets/:key/accept",
    route(async (req, res) => {
      const result = await batches.update((draft) => accept(batchOr404(draft, req.params.id), req.params.key.toUpperCase(), Date.now()));
      if (!result.ok) throw conflict(result.error);
      res.json({ batch: decorate((await batches.get()).batches[req.params.id]) });
    }),
  );

  router.post(
    "/batches/:id/send-feedback",
    route(async (req, res) => {
      const outcome = await runner.sendFeedback(req.params.id);
      const doc = await batches.get();
      res.json({ batch: decorate(batchOr404(doc, req.params.id)), ...outcome });
    }),
  );

  router.post(
    "/batches/:id/archive",
    route(async (req, res) => {
      const result = await batches.update((draft) => {
        const batch = batchOr404(draft, req.params.id);
        if (!canArchive(batch)) return { ok: false, error: "close every cluster first" };
        batch.archivedAt = Date.now();
        batch.updatedAt = Date.now();
        return { ok: true };
      });
      if (!result.ok) throw conflict(result.error);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/batches/:id/unarchive",
    route(async (req, res) => {
      await batches.update((draft) => {
        const batch = batchOr404(draft, req.params.id);
        batch.archivedAt = null;
        batch.updatedAt = Date.now();
        return { ok: true };
      });
      res.json({ batch: decorate((await batches.get()).batches[req.params.id]) });
    }),
  );

  router.post(
    "/batches/:id/delete",
    route(async (req, res) => {
      const result = await batches.update((draft) => {
        const batch = batchOr404(draft, req.params.id);
        if (!canDelete(batch)) return { ok: false, error: "a cluster is still running - close it first" };
        delete draft.batches[req.params.id];
        return { ok: true };
      });
      if (!result.ok) throw conflict(result.error);
      res.json({ ok: true });
    }),
  );
}

// The socket, the sweep and the hook subscription outlive a route: without
// this they would keep running after the extension is disabled, in a module
// Node cannot unload.
export async function deactivate() {
  for (const res of openBoards) {
    try {
      res.end();
    } catch {
      // The client is already gone.
    }
  }
  openBoards = new Set();
  await activeRunner?.stop();
  activeRunner = null;
}
