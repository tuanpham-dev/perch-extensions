// The clustering prompt's promises, every way a reply can be wrong, and the
// grouping used when no AI is configured. What the model is told and what it
// is trusted with are the two halves of this file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClusterPrompt, heuristicClusters, parseClusterReply } from "../analysis.mjs";
import type { IssueDetail } from "./types.ts";

function detail(patch: Partial<IssueDetail> & { key: string }): IssueDetail {
  return {
    summary: `${patch.key} summary`,
    description: "",
    status: "To Do",
    type: "Task",
    priority: "Medium",
    labels: [],
    comments: [],
    url: `https://j/browse/${patch.key}`,
    ...patch,
  } as IssueDetail;
}

const TICKETS = [detail({ key: "CAP-1" }), detail({ key: "CAP-2" })];

// ---- the prompt ----

test("the prompt carries every ticket's brief and asks for JSON only", () => {
  const prompt = buildClusterPrompt({ criteria: "by area", tickets: TICKETS });
  assert.match(prompt, /CAP-1: CAP-1 summary/);
  assert.match(prompt, /CAP-2: CAP-2 summary/);
  assert.match(prompt, /by area/);
  assert.match(prompt, /Reply with JSON and nothing else/);
  assert.match(prompt, /"id" is always null/);
});

test("reading the codebase names the repository and forbids changing it", () => {
  const prompt = buildClusterPrompt({ criteria: "", readCodebase: true, repo: "/works/acme", tickets: TICKETS });
  assert.match(prompt, /running inside the repository at \/works\/acme/);
  assert.match(prompt, /Do not change any file/);
});

test("without the codebase option the prompt never claims the model can read files", () => {
  const prompt = buildClusterPrompt({ criteria: "", tickets: TICKETS });
  assert.ok(!/inside the repository/.test(prompt));
});

test("an empty criteria still gives the model a rule to follow", () => {
  const prompt = buildClusterPrompt({ criteria: "   ", tickets: TICKETS });
  assert.match(prompt, /Group tickets that touch the same area of the codebase/);
});

test("adding tickets lists the existing clusters, their ids and what they hold", () => {
  const prompt = buildClusterPrompt({
    criteria: "by area",
    tickets: [detail({ key: "CAP-3" })],
    existing: [{ id: "cls_1", name: "Checkout", state: "running", keys: ["CAP-1"], rationale: "cart code" }],
  });
  assert.match(prompt, /id "cls_1" - "Checkout" \(running\), holds CAP-1/);
  assert.match(prompt, /Do not move, reorder or remove the tickets they already hold/);
  assert.match(prompt, /1 new ticket to place/);
});

// ---- parsing ----

const ALLOWED = { allowedKeys: ["CAP-1", "CAP-2"] };

test("a bare JSON reply is taken as it is", () => {
  const result = parseClusterReply('{"clusters":[{"id":null,"name":"A","rationale":"r","files":["a.js"],"keys":["CAP-1","CAP-2"]}],"unclustered":[]}', ALLOWED);
  assert.equal(result.ok, true);
  assert.deepEqual(result.proposal.clusters[0].keys, ["CAP-1", "CAP-2"]);
  assert.deepEqual(result.proposal.clusters[0].files, ["a.js"]);
  assert.deepEqual(result.warnings, []);
});

test("a fenced reply is unwrapped rather than rejected", () => {
  const reply = '```json\n{"clusters":[{"name":"A","keys":["CAP-1","CAP-2"]}]}\n```';
  const result = parseClusterReply(reply, ALLOWED);
  assert.equal(result.ok, true);
  assert.deepEqual(result.proposal.clusters[0].keys, ["CAP-1", "CAP-2"]);
});

test("a reply with a sentence in front of the JSON still parses", () => {
  const reply = 'Here is the grouping:\n{"clusters":[{"name":"A","keys":["CAP-1","CAP-2"]}]}';
  assert.equal(parseClusterReply(reply, ALLOWED).ok, true);
});

test("a reply that is not JSON at all is refused with something the user can act on", () => {
  const result = parseClusterReply("I cannot help with that.", ALLOWED);
  assert.equal(result.ok, false);
  assert.match(result.error, /not JSON/);
});

test("a ticket the model invented is dropped, and says so", () => {
  const result = parseClusterReply('{"clusters":[{"name":"A","keys":["CAP-1","CAP-42"]}]}', ALLOWED);
  assert.deepEqual(result.proposal.clusters[0].keys, ["CAP-1"]);
  assert.match(result.warnings.join(" "), /CAP-42 is not one of the tickets/);
});

test("a ticket the model forgot lands in unclustered instead of vanishing", () => {
  const result = parseClusterReply('{"clusters":[{"name":"A","keys":["CAP-1"]}]}', ALLOWED);
  assert.deepEqual(result.proposal.unclustered, ["CAP-2"]);
  assert.match(result.warnings.join(" "), /CAP-2 was not placed anywhere/);
});

test("a ticket in two clusters is kept in the first and reported once", () => {
  const result = parseClusterReply('{"clusters":[{"name":"A","keys":["CAP-1"]},{"name":"B","keys":["CAP-1","CAP-2"]}]}', ALLOWED);
  assert.deepEqual(result.proposal.clusters[0].keys, ["CAP-1"]);
  assert.deepEqual(result.proposal.clusters[1].keys, ["CAP-2"]);
  assert.match(result.warnings.join(" "), /CAP-1 was listed more than once/);
});

test("lowercase keys from the model are matched against the real ones", () => {
  const result = parseClusterReply('{"clusters":[{"name":"A","keys":["cap-1","cap-2"]}]}', ALLOWED);
  assert.deepEqual(result.proposal.clusters[0].keys, ["CAP-1", "CAP-2"]);
});

test("an id that names no existing cluster becomes a new cluster rather than a dangling reference", () => {
  const result = parseClusterReply('{"clusters":[{"id":"cls_gone","name":"A","keys":["CAP-1","CAP-2"]}]}', {
    ...ALLOWED,
    existing: [{ id: "cls_1", name: "Real" }],
  });
  assert.equal(result.proposal.clusters[0].id, null);
  assert.match(result.warnings.join(" "), /named a cluster that does not exist/);
});

test("an id that does exist is kept, so the tickets reach that agent", () => {
  const result = parseClusterReply('{"clusters":[{"id":"cls_1","name":"A","keys":["CAP-1","CAP-2"]}]}', {
    ...ALLOWED,
    existing: [{ id: "cls_1", name: "Real" }],
  });
  assert.equal(result.proposal.clusters[0].id, "cls_1");
  assert.deepEqual(result.warnings, []);
});

test("an over-long name and an over-long file list are cut to size, not refused", () => {
  const files = Array.from({ length: 30 }, (_, i) => `f${i}.js`);
  const result = parseClusterReply(
    JSON.stringify({ clusters: [{ name: "x".repeat(200), files, keys: ["CAP-1", "CAP-2"] }] }),
    ALLOWED,
  );
  assert.equal(result.proposal.clusters[0].name.length, 60);
  assert.equal(result.proposal.clusters[0].files.length, 20);
});

test("a reply with an empty clusters list is refused rather than making an empty batch", () => {
  const result = parseClusterReply('{"clusters":[]}', ALLOWED);
  assert.equal(result.ok, false);
  assert.match(result.error, /no clusters/);
});

// ---- no AI ----

test("tickets under the same epic group together, named after it", () => {
  const result = heuristicClusters([
    detail({ key: "CAP-1", parent: { key: "CAP-100", summary: "Checkout" } } as Partial<IssueDetail> & { key: string }),
    detail({ key: "CAP-2", parent: { key: "CAP-100", summary: "Checkout" } } as Partial<IssueDetail> & { key: string }),
  ]);
  assert.equal(result.clusters.length, 1);
  assert.deepEqual(result.clusters[0].keys, ["CAP-1", "CAP-2"]);
  assert.match(result.clusters[0].rationale, /Grouped by epic/);
  assert.match(result.clusters[0].rationale, /no AI configured/);
});

test("without an epic the component decides, and without that the label", () => {
  const result = heuristicClusters([
    detail({ key: "CAP-1", components: ["Cart"] } as Partial<IssueDetail> & { key: string }),
    detail({ key: "CAP-2", labels: ["nav"] }),
  ]);
  const names = result.clusters.map((cluster) => cluster.name).sort();
  assert.deepEqual(names, ["Cart", "nav"]);
});

test("a ticket with none of the three is left unclustered rather than put in a junk cluster", () => {
  const result = heuristicClusters([detail({ key: "CAP-1" }), detail({ key: "CAP-2", labels: ["nav"] })]);
  assert.deepEqual(result.unclustered, ["CAP-1"]);
  assert.deepEqual(result.clusters.map((c) => c.keys), [["CAP-2"]]);
});
