#!/usr/bin/env node
// A stand-in for a Jira Cloud site, for developing and QA-ing the Jira
// extension without a real Atlassian account.
//
// Why it exists: the batch flow's checkpoints ("select 6 tickets, analyze,
// start two clusters, report them done") need tickets that are the same every
// run. A real site's backlog moves under you, and a plan checkpoint written
// against live rows is a checkpoint that stops being reproducible - so the
// fixture ships with the extension's tests rather than being improvised.
//
// It serves the subset of the REST v3 API the extension actually calls (grep
// `jiraFetch(cfg,` in jira/server.js for the list), with two projects:
//
//   CAP  12 tickets across 3 epics, with components and labels
//   OPS   3 tickets, so "paste keys from another project" has something to find
//
// Any basic-auth credentials are accepted: it is a fixture, it holds nothing.
//
//   node scripts/fake-jira.mjs --port 8443
//
// The extension refuses a site URL that is not https, so this serves TLS with
// a self-signed certificate minted at startup (openssl is required, and the
// key never leaves a 0700 temp directory). Point Perch at it with:
//
//   jira.siteUrl  https://localhost:8443
//   jira.email    dev@example.com
//   API token     anything
//
// and start the dev server with NODE_TLS_REJECT_UNAUTHORIZED=0 so Node
// accepts the self-signed certificate. Never do that on a real machine's
// production server - it disables certificate checking for every request that
// process makes, which is exactly why this is a development fixture.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8443;

// ---- The data ----

const ME = { accountId: "acc-me", displayName: "Dev User", emailAddress: "dev@example.com" };
const OTHER = { accountId: "acc-other", displayName: "Someone Else" };

const STATUSES = [
  { name: "To Do", category: "new" },
  { name: "In Progress", category: "indeterminate" },
  { name: "In Review", category: "indeterminate" },
  { name: "Done", category: "done" },
];
const TYPES = ["Task", "Bug", "Story", "Epic"];
const PRIORITIES = ["Highest", "High", "Medium", "Low"];

// Written as one row per ticket so a case can be added by hand: the three
// epics are what the heuristic grouping falls back to, and the components and
// labels are what it falls back to after that.
const RAW = [
  ["CAP-101", "Epic", "Checkout and cart", "", [], [], "To Do", "Medium", null],
  ["CAP-102", "Epic", "Navigation", "", [], [], "To Do", "Medium", null],
  ["CAP-103", "Epic", "Transactional email", "", [], [], "To Do", "Medium", null],

  ["CAP-110", "Bug", "Cart drawer totals are stale after a quantity change", "The subtotal in the cart drawer keeps the old value until the drawer is reopened. It should recompute whenever a line item changes.", ["Cart"], ["checkout"], "To Do", "High", "CAP-101"],
  ["CAP-111", "Task", "Apply a gift card at checkout", "Add a gift card field to the payment step and show the remaining balance after it is applied.", ["Checkout"], ["checkout"], "To Do", "Medium", "CAP-101"],
  ["CAP-112", "Bug", "Discount code validation accepts expired codes", "An expired code is accepted client side and only rejected after payment is attempted.", ["Checkout"], ["checkout", "bug"], "To Do", "Highest", "CAP-101"],
  ["CAP-113", "Task", "Disable the checkout button while the cart is empty", "", ["Checkout"], [], "To Do", "Low", "CAP-101"],

  ["CAP-120", "Bug", "Sticky header flickers when scrolling up on iOS", "The header re-renders on every scroll event instead of on a threshold.", ["Header"], ["mobile"], "To Do", "High", "CAP-102"],
  ["CAP-121", "Bug", "Header overflows on tablet widths", "Between 768px and 1024px the nav items wrap behind the logo.", ["Header"], ["responsive"], "To Do", "Medium", "CAP-102"],
  ["CAP-122", "Task", "Keyboard navigation for the mega menu", "Arrow keys should move between top-level items and Escape should close the panel.", ["Header"], ["a11y"], "To Do", "Medium", "CAP-102"],

  ["CAP-130", "Task", "Rewrite the order confirmation copy", "Marketing has new wording; see the linked doc in the comments.", ["Email"], ["content"], "To Do", "Low", "CAP-103"],
  ["CAP-131", "Task", "Add a shipping update footer", "", ["Email"], ["content"], "To Do", "Low", "CAP-103"],

  ["CAP-140", "Story", "Investigate slow search on large catalogues", "Search takes over two seconds on catalogues above 10k products. Find out where the time goes before proposing a fix.", [], [], "To Do", "Medium", null],

  ["OPS-41", "Task", "Rotate the staging deploy key", "", ["Infra"], ["ops"], "To Do", "Medium", null],
  ["OPS-42", "Bug", "Nightly backup job reports success on a partial upload", "", ["Infra"], ["ops", "bug"], "To Do", "High", null],
  ["OPS-43", "Task", "Add a dashboard panel for queue depth", "", ["Infra"], ["ops"], "To Do", "Low", null],
];

const COMMENTS = {
  "CAP-110": [
    ["Someone Else", "2026-09-02T09:12:00.000+0000", "Reproduced on Safari 17 - the drawer's own render is fine, it is the totals partial that is cached."],
    ["Dev User", "2026-09-03T11:40:00.000+0000", "Decision from standup: recompute on the line-item change event rather than polling."],
  ],
  "CAP-112": [["Someone Else", "2026-09-05T14:02:00.000+0000", "The expiry check exists server side already; the client just never calls it."]],
  "CAP-130": [["Someone Else", "2026-09-06T08:30:00.000+0000", "New copy is in the shared drive; ping me if you cannot open it."]],
};

// Jira hands descriptions and comments back as ADF, and the extension's
// adfToMarkdown is what turns them into what the agent reads - so the fixture
// has to speak ADF too, or the one conversion nobody else tests goes untested.
function adf(text) {
  if (!text) return null;
  return {
    type: "doc",
    version: 1,
    content: text.split("\n\n").map((para) => ({
      type: "paragraph",
      content: [{ type: "text", text: para }],
    })),
  };
}

const ISSUES = new Map(
  RAW.map(([key, type, summary, description, components, labels, status, priority, parent]) => [
    key,
    {
      key,
      type,
      summary,
      description,
      components,
      labels,
      status,
      priority,
      parent,
      assignee: key === "CAP-110" || key === "CAP-120" ? ME : null,
      updated: "2026-09-20T10:00:00.000+0000",
      created: "2026-09-01T10:00:00.000+0000",
    },
  ]),
);

const PROJECTS = [
  { key: "CAP", name: "Customer App" },
  { key: "OPS", name: "Operations" },
];

function statusOf(name) {
  const found = STATUSES.find((s) => s.name === name) ?? STATUSES[0];
  return { name: found.name, statusCategory: { key: found.category } };
}

function issueFields(issue) {
  const parent = issue.parent ? ISSUES.get(issue.parent) : null;
  return {
    summary: issue.summary,
    description: adf(issue.description),
    status: statusOf(issue.status),
    issuetype: { name: issue.type },
    priority: { name: issue.priority },
    labels: issue.labels,
    components: issue.components.map((name) => ({ name })),
    parent: parent ? { key: parent.key, fields: { summary: parent.summary } } : undefined,
    assignee: issue.assignee ? { accountId: issue.assignee.accountId, displayName: issue.assignee.displayName } : null,
    reporter: { displayName: OTHER.displayName },
    project: { key: issue.key.split("-")[0], name: PROJECTS.find((p) => p.key === issue.key.split("-")[0])?.name },
    created: issue.created,
    updated: issue.updated,
  };
}

// ---- JQL, enough of it ----
//
// Only the shapes jira/server.js composes: a project or key filter, the
// current user, a status-category exclusion, the facet clauses, and ORDER BY.
// Anything it does not recognise is ignored rather than failing, because a
// fixture that 400s on a clause the extension legitimately sends would send
// whoever is debugging after the wrong thing.
function runJql(jql) {
  let rows = [...ISSUES.values()];
  const keyIn = jql.match(/key\s+in\s+\(([^)]*)\)/i);
  if (keyIn) {
    const wanted = new Set(keyIn[1].split(",").map((k) => k.trim().replace(/^["']|["']$/g, "").toUpperCase()));
    rows = rows.filter((issue) => wanted.has(issue.key));
  }
  const project = jql.match(/project\s*=\s*["']?([A-Z][A-Z0-9_]*)["']?/i);
  if (project) rows = rows.filter((issue) => issue.key.startsWith(`${project[1].toUpperCase()}-`));
  if (/assignee\s*=\s*currentUser\(\)/i.test(jql)) rows = rows.filter((issue) => issue.assignee?.accountId === ME.accountId);
  if (/statusCategory\s*!=\s*Done/i.test(jql)) rows = rows.filter((issue) => statusOf(issue.status).statusCategory.key !== "done");

  const statusIn = jql.match(/status\s+in\s+\(([^)]*)\)/i);
  if (statusIn) {
    const wanted = new Set(statusIn[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "").toLowerCase()));
    rows = rows.filter((issue) => wanted.has(issue.status.toLowerCase()));
  }
  const typeIn = jql.match(/issuetype\s+in\s+\(([^)]*)\)/i);
  if (typeIn) {
    const wanted = new Set(typeIn[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "").toLowerCase()));
    rows = rows.filter((issue) => wanted.has(issue.type.toLowerCase()));
  }
  const text = jql.match(/summary\s*~\s*"([^"]*)"/i);
  if (text) rows = rows.filter((issue) => issue.summary.toLowerCase().includes(text[1].toLowerCase()));

  const order = jql.match(/ORDER\s+BY\s+(\w+)\s*(ASC|DESC)?/i);
  if (order) {
    const field = order[1].toLowerCase();
    const dir = (order[2] ?? "DESC").toUpperCase() === "ASC" ? 1 : -1;
    const value = (issue) =>
      field === "key" ? issue.key : field === "summary" ? issue.summary : field === "status" ? issue.status : issue.updated;
    rows.sort((a, b) => (value(a) < value(b) ? -dir : value(a) > value(b) ? dir : a.key.localeCompare(b.key)));
  } else {
    rows.sort((a, b) => a.key.localeCompare(b.key));
  }
  return rows;
}

// ---- Routing ----

function send(res, status, body) {
  const text = body === null ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function handle(req, res, url) {
  const p = url.pathname;
  if (process.env.FAKE_JIRA_LOG) console.log(`${req.method} ${p} auth=${req.headers.authorization ? "yes" : "no"}`);

  if (p === "/rest/api/3/myself") return send(res, 200, ME);

  if (p === "/rest/api/3/search/jql" && req.method === "POST") {
    const body = await readBody(req);
    const max = Number(body.maxResults) || 50;
    const rows = runJql(String(body.jql ?? ""));
    return send(res, 200, {
      issues: rows.slice(0, max).map((issue) => ({ key: issue.key, fields: issueFields(issue) })),
      total: rows.length,
    });
  }

  const comment = p.match(/^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)\/comment$/i);
  if (comment) {
    const rows = (COMMENTS[comment[1].toUpperCase()] ?? []).map(([author, created, text]) => ({
      author: { displayName: author },
      created,
      body: adf(text),
    }));
    // The extension asks for newest first and reverses; mirror that.
    return send(res, 200, { comments: [...rows].reverse() });
  }

  const transitions = p.match(/^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)\/transitions$/i);
  if (transitions) {
    const issue = ISSUES.get(transitions[1].toUpperCase());
    if (!issue) return send(res, 404, { errorMessages: [`Issue ${transitions[1]} does not exist`] });
    if (req.method === "POST") {
      const body = await readBody(req);
      const target = STATUSES[Number(body?.transition?.id ?? 2) - 1] ?? STATUSES[1];
      issue.status = target.name;
      return send(res, 204, null);
    }
    return send(res, 200, {
      transitions: STATUSES.map((s, i) => ({ id: String(i + 1), name: s.name, to: { name: s.name, statusCategory: { key: s.category } } })),
    });
  }

  const assignee = p.match(/^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)\/assignee$/i);
  if (assignee) {
    const issue = ISSUES.get(assignee[1].toUpperCase());
    if (!issue) return send(res, 404, { errorMessages: ["no such issue"] });
    issue.assignee = ME;
    return send(res, 204, null);
  }

  const one = p.match(/^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)$/i);
  if (one) {
    const issue = ISSUES.get(one[1].toUpperCase());
    if (!issue) return send(res, 404, { errorMessages: [`Issue does not exist or you do not have permission to see it.`] });
    return send(res, 200, { key: issue.key, fields: issueFields(issue) });
  }

  const projectStatuses = p.match(/^\/rest\/api\/3\/project\/([A-Z][A-Z0-9_]*)\/statuses$/i);
  if (projectStatuses) {
    return send(
      res,
      200,
      TYPES.map((name) => ({ name, statuses: STATUSES.map((s) => ({ name: s.name, statusCategory: { key: s.category } })) })),
    );
  }

  if (p === "/rest/api/3/project/search") {
    return send(res, 200, { values: PROJECTS, isLast: true });
  }
  if (p === "/rest/api/3/status") {
    return send(res, 200, STATUSES.map((s) => ({ name: s.name, statusCategory: { key: s.category } })));
  }
  if (p === "/rest/api/3/issuetype") return send(res, 200, TYPES.map((name) => ({ name })));
  if (p === "/rest/api/3/priority") return send(res, 200, PRIORITIES.map((name) => ({ name })));
  if (p === "/rest/api/3/user/assignable/search") return send(res, 200, [ME, OTHER]);

  send(res, 404, { errorMessages: [`fake-jira has no route for ${req.method} ${p}`] });
}

// ---- TLS and startup ----

function selfSignedCert() {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-jira-"), { mode: 0o700 });
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "30", "-subj", "/CN=localhost"],
      { stdio: "ignore" },
    );
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`could not mint a self-signed certificate with openssl: ${err.message}`);
  }
  const pair = { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  rmSync(dir, { recursive: true, force: true });
  return pair;
}

const server = https.createServer(selfSignedCert(), (req, res) => {
  const url = new URL(req.url ?? "/", "https://localhost");
  handle(req, res, url).catch((err) => {
    console.error("fake-jira:", err);
    send(res, 500, { errorMessages: [String(err?.message ?? err)] });
  });
});

server.listen(port, () => {
  console.log(`fake-jira listening on https://localhost:${port}`);
  console.log(`  ${ISSUES.size} issues across ${PROJECTS.map((p) => p.key).join(", ")}`);
  console.log("  set jira.siteUrl to that URL, any email and any token");
  console.log("  start Perch with NODE_TLS_REJECT_UNAUTHORIZED=0 (development only)");
});
