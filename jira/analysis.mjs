// Turning a pile of tickets into clusters: the prompt the AI is given, the
// parser that refuses to trust what comes back, and the grouping used when
// there is no AI configured at all.
//
// Plain ESM beside server.js for the same reason brief.mjs is - the host
// loads server.js as plain JS - and pure, so src/analysis.test.ts can pin the
// prompt's promises and every way a reply can be wrong.
//
// Two layers guard the reply, deliberately: parseClusterReply protects the
// SHAPE (is this JSON, are these keys real, did it repeat itself), and
// batchModel's applyProposal protects the BATCH (is this key already being
// worked, can that cluster still take tickets). A reply that passes the first
// can still be refused by the second, and neither is the other's backstop.
import { buildAgentBrief } from "./brief.mjs";

const MAX_NAME = 60;
const MAX_FILES = 20;

// The output contract, quoted to the model verbatim. One line per rule
// because a model that skims still sees the shape.
function contract(addOnly) {
  return [
    "Reply with JSON and nothing else - no explanation before it, no code fence around it:",
    "",
    '{"clusters":[{"id":null,"name":"Short name","rationale":"One sentence on why these belong together","files":["path/one.js"],"keys":["KEY-1","KEY-2"]}],"unclustered":["KEY-9"]}',
    "",
    '- "name" is at most 60 characters and names the area of work, not the tickets.',
    '- "rationale" is one sentence.',
    '- "files" is the files or areas you expect the cluster to change. Use [] if you do not know.',
    '- "keys" is that cluster\'s tickets, in the order they should be worked - earlier ones unblocking later ones.',
    '- "unclustered" is any ticket that does not belong with the others. Use [] if every ticket is placed.',
    addOnly
      ? '- "id" is the id of an existing cluster to add to, or null for a new cluster.'
      : '- "id" is always null.',
    "- Every ticket appears exactly once, across clusters and unclustered.",
  ].join("\n");
}

export function buildClusterPrompt({ criteria, readCodebase = false, repo = "", tickets, existing = null }) {
  const addOnly = Array.isArray(existing) && existing.length > 0;
  const lines = [
    addOnly
      ? "You are adding new Jira tickets to a batch of work that is already under way."
      : "You are splitting a set of Jira tickets into clusters.",
    "",
    "Each cluster becomes one git worktree with one AI coding agent working its tickets in order, so two clusters must not need to change the same files at the same time.",
    "",
    "## How to split them",
    "",
    criteria.trim() || "Group tickets that touch the same area of the codebase.",
  ];

  if (readCodebase) {
    lines.push(
      "",
      "## Read the code first",
      "",
      `You are running inside the repository at ${repo}. Before you group anything, look at the code each ticket would touch - search for the components, files and strings the tickets name.`,
      "Group by what the work actually touches, not by what the wording suggests, and list those files in each cluster's \"files\".",
      "Do not change any file, and do not commit anything: this is a read-only look.",
    );
  }

  if (addOnly) {
    lines.push(
      "",
      "## The clusters that already exist",
      "",
      "Place each NEW ticket into one of these, or into a new cluster of its own. Do not move, reorder or remove the tickets they already hold - those are being worked right now.",
      "",
    );
    for (const cluster of existing) {
      const holds = cluster.keys.length > 0 ? cluster.keys.join(", ") : "nothing yet";
      lines.push(`- id "${cluster.id}" - "${cluster.name}" (${cluster.state}), holds ${holds}.${cluster.rationale ? ` ${cluster.rationale}` : ""}`);
    }
    lines.push("", "Only these ids exist. Use null for anything else.");
  }

  lines.push("", "## Output", "", contract(addOnly), "", "## The tickets", "");
  lines.push(
    addOnly
      ? `${tickets.length} new ${tickets.length === 1 ? "ticket" : "tickets"} to place:`
      : `${tickets.length} ${tickets.length === 1 ? "ticket" : "tickets"}:`,
  );
  for (const detail of tickets) lines.push("", "---", "", buildAgentBrief(detail));
  return lines.join("\n");
}

// Models wrap JSON in a fence, in a sentence, or in both. Pulling the outermost
// braces out is more forgiving than demanding a bare object, and costs nothing
// when the reply is already clean.
function extractJson(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  const body = fenced ? fenced[1].trim() : trimmed;
  if (body.startsWith("{")) return body;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  return first !== -1 && last > first ? body.slice(first, last + 1) : body;
}

function strings(value, limit) {
  if (!Array.isArray(value)) return [];
  const out = value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
  return typeof limit === "number" ? out.slice(0, limit) : out;
}

// `allowedKeys` is what the batch actually holds. `existing` is the clusters a
// reply may name by id (add mode); anything else becomes a new cluster rather
// than a dangling reference.
export function parseClusterReply(text, { allowedKeys, existing = [] } = {}) {
  const allowed = new Set(allowedKeys ?? []);
  const knownIds = new Set((existing ?? []).map((cluster) => cluster.id));
  let parsed;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    return { ok: false, error: "The AI's reply was not JSON. Try again, or group the tickets yourself." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.clusters)) {
    return { ok: false, error: 'The AI\'s reply had no "clusters" list.' };
  }

  const warnings = [];
  const seen = new Set();
  const clusters = [];
  for (const raw of parsed.clusters) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const name = (typeof raw.name === "string" ? raw.name.trim() : "").slice(0, MAX_NAME) || "Cluster";
    const keys = [];
    for (const key of strings(raw.keys)) {
      const upper = key.toUpperCase();
      if (!allowed.has(upper)) {
        warnings.push(`${key} is not one of the tickets - left out of "${name}"`);
        continue;
      }
      if (seen.has(upper)) {
        warnings.push(`${key} was listed more than once - kept in "${clusters.find((c) => c.keys.includes(upper))?.name ?? name}"`);
        continue;
      }
      seen.add(upper);
      keys.push(upper);
    }
    let id = typeof raw.id === "string" && raw.id ? raw.id : null;
    if (id && !knownIds.has(id)) {
      warnings.push(`"${name}" named a cluster that does not exist - added as a new one`);
      id = null;
    }
    clusters.push({
      id,
      name,
      rationale: typeof raw.rationale === "string" ? raw.rationale.trim() : "",
      files: strings(raw.files, MAX_FILES),
      keys,
    });
  }

  if (clusters.length === 0) return { ok: false, error: "The AI proposed no clusters." };

  // A ticket the reply forgot is not lost: it lands in Unclustered, where the
  // user can see it and drag it somewhere. Silently dropping it would mean a
  // ticket that was selected simply never gets worked.
  const missed = [...allowed].filter((key) => !seen.has(key));
  const stated = strings(parsed.unclustered).map((key) => key.toUpperCase());
  const unclustered = [...new Set([...stated.filter((key) => allowed.has(key) && !seen.has(key)), ...missed])];
  for (const key of missed) {
    if (!stated.includes(key)) warnings.push(`${key} was not placed anywhere - left unclustered`);
  }

  return { ok: true, proposal: { clusters, unclustered }, warnings };
}

// ---- No AI configured ----
//
// Epic, then component, then label: the fields a team already uses to say
// "these belong together". Blind to what the tickets touch, which is exactly
// what the AI is for - so the grouping says which field it used, and the
// panel repeats that rather than passing it off as analysis.
export function heuristicClusters(details) {
  const groups = new Map();
  for (const detail of details) {
    const { field, value } = groupingOf(detail);
    const id = `${field}:${value}`;
    if (!groups.has(id)) groups.set(id, { field, value, keys: [] });
    groups.get(id).keys.push(detail.key);
  }
  const clusters = [...groups.values()]
    .filter((group) => group.field !== "none")
    .map((group) => ({
      id: null,
      name: group.value.slice(0, MAX_NAME),
      rationale: `Grouped by ${group.field}: ${group.value} (no AI configured)`,
      files: [],
      keys: group.keys,
    }));
  const unclustered = groups.get("none:none")?.keys ?? [];
  return { clusters, unclustered };
}

function groupingOf(detail) {
  const parentKey = detail.parent?.key;
  if (parentKey) return { field: "epic", value: detail.parent.summary ? `${parentKey} ${detail.parent.summary}` : parentKey };
  const component = Array.isArray(detail.components) ? detail.components.find((name) => typeof name === "string" && name.trim()) : null;
  if (component) return { field: "component", value: component.trim() };
  const label = Array.isArray(detail.labels) ? detail.labels.find((name) => typeof name === "string" && name.trim()) : null;
  if (label) return { field: "label", value: label.trim() };
  return { field: "none", value: "none" };
}
