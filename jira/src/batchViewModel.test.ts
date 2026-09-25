// What the board shows, pinned: the column a ticket lands in, what the
// cluster filter does (and does not) hide, and the order cards sit in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clusterChips, columns, feedbackPending, sinceLabel, skillsLabel, COLUMNS, qaColumns, qaQueue, shipBlockers } from "./batchViewModel.ts";
import type { Batch, Cluster, SkillRecord, TicketState, TicketStateName } from "./batchTypes.ts";

const NOW = 1_700_000_000_000;

function cluster(patch: Partial<Cluster> & { id: string }): Cluster {
  return {
    name: patch.id,
    rationale: "",
    files: [],
    color: 0,
    keys: [],
    branch: "",
    worktreePath: "",
    worktreeRemovedAt: null,
    sessionName: "",
    windowId: "",
    agentId: "",
    state: "running",
    storedState: "running",
    actions: [],
    working: null,
    startedAt: NOW,
    stoppedReason: "",
    lastError: "",
    lastEventAt: NOW,
    awaiting: null,
    notes: [],
    ...patch,
  };
}

function ticketState(state: TicketStateName, since = NOW, patch: Partial<TicketState> = {}): TicketState {
  return { state, clusterId: "c1", since, history: [], summary: "", reason: "", feedbackDraft: "", feedback: [], ...patch };
}

function batch(patch: Partial<Batch> = {}): Batch {
  const keys = ["CAP-1", "CAP-2", "CAP-3"];
  return {
    id: "bat_1",
    name: "Batch",
    repo: "/repo",
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    criteria: "",
    readCodebase: false,
    agentId: "",
    tickets: Object.fromEntries(keys.map((key) => [key, { key, summary: `${key} summary`, type: "Task", priority: "", url: "", projectKey: "CAP" }])),
    clusters: [cluster({ id: "c1", name: "One", color: 0, keys: ["CAP-1", "CAP-2"] })],
    ticketStates: {},
    unclustered: ["CAP-3"],
    pendingProposal: null,
    counts: {} as Batch["counts"],
    pendingFeedback: 0,
    canArchive: false,
    canDelete: false,
    ...patch,
  };
}

test("the board always draws all seven columns, in one order, however empty", () => {
  const result = columns(batch());
  assert.deepEqual(
    result.map((c) => c.state),
    COLUMNS.map((c) => c.state),
  );
  assert.equal(result.length, 7);
});

test("a ticket no agent has started yet sits in Queued and says so", () => {
  const result = columns(batch());
  const queued = result.find((c) => c.state === "queued")!;
  assert.deepEqual(queued.cards.map((card) => card.key).sort(), ["CAP-1", "CAP-2", "CAP-3"]);
  assert.equal(queued.cards.every((card) => card.started === false), true);
  assert.equal(sinceLabel(queued.cards[0].since, NOW), "not started");
});

test("each ticket lands in the column of its own reported state", () => {
  const result = columns(
    batch({
      ticketStates: {
        "CAP-1": ticketState("review", NOW - 60_000, { summary: "moved the totals" }),
        "CAP-2": ticketState("needs-you"),
      },
    }),
  );
  const at = (state: string) => result.find((c) => c.state === state)!.cards.map((card) => card.key);
  assert.deepEqual(at("review"), ["CAP-1"]);
  assert.deepEqual(at("needs-you"), ["CAP-2"]);
  assert.deepEqual(at("queued"), ["CAP-3"]);
});

test("a reviewed card carries the agent's summary, a failed one its reason", () => {
  const result = columns(
    batch({
      ticketStates: {
        "CAP-1": ticketState("review", NOW, { summary: "moved the totals" }),
        "CAP-2": ticketState("failed", NOW, { reason: "needs a design decision" }),
      },
    }),
  );
  const card = (state: string) => result.find((c) => c.state === state)!.cards[0];
  assert.equal(card("review").note, "moved the totals");
  assert.equal(card("failed").note, "needs a design decision");
});

test("the cluster filter narrows every column at once", () => {
  const b = batch({
    clusters: [
      cluster({ id: "c1", name: "One", color: 0, keys: ["CAP-1"] }),
      cluster({ id: "c2", name: "Two", color: 1, keys: ["CAP-2"] }),
    ],
    unclustered: ["CAP-3"],
  });
  const result = columns(b, new Set(["c2"]));
  const queued = result.find((c) => c.state === "queued")!;
  assert.deepEqual(queued.cards.map((card) => card.key), ["CAP-2"]);
  assert.equal(result.length, 7, "and never takes a column away");
});

test("an empty filter means every cluster, so one added later is not hidden", () => {
  const b = batch({
    clusters: [cluster({ id: "c1", keys: ["CAP-1"] }), cluster({ id: "c9", keys: ["CAP-2"] })],
  });
  const keys = columns(b, new Set()).find((c) => c.state === "queued")!.cards.map((card) => card.key);
  assert.deepEqual(keys.sort(), ["CAP-1", "CAP-2", "CAP-3"]);
});

test("a card carries its cluster's name and colour, and an unclustered one says so", () => {
  const cards = columns(batch()).find((c) => c.state === "queued")!.cards;
  const one = cards.find((card) => card.key === "CAP-1")!;
  const loose = cards.find((card) => card.key === "CAP-3")!;
  assert.equal(one.clusterName, "One");
  assert.equal(one.color, 0);
  assert.equal(loose.clusterName, "Unclustered");
  assert.equal(loose.clusterId, null);
});

test("inside a column the longest-waiting card comes first", () => {
  const result = columns(
    batch({
      ticketStates: {
        "CAP-1": ticketState("review", NOW - 10_000),
        "CAP-2": ticketState("review", NOW - 90_000),
      },
    }),
  );
  assert.deepEqual(result.find((c) => c.state === "review")!.cards.map((c) => c.key), ["CAP-2", "CAP-1"]);
});

test("a card with no clock of its own sorts after the ones that have one", () => {
  const result = columns(batch({ ticketStates: { "CAP-2": ticketState("queued", NOW - 1000) } }));
  assert.deepEqual(result.find((c) => c.state === "queued")!.cards.map((c) => c.key), ["CAP-2", "CAP-1", "CAP-3"]);
});

test("a chip per cluster, with what it holds and what it is waiting on", () => {
  const b = batch({ clusters: [cluster({ id: "c1", name: "One", keys: ["CAP-1", "CAP-2"], state: "waiting", awaiting: "waiting on a permission prompt" })] });
  assert.deepEqual(clusterChips(b), [
    { id: "c1", name: "One", color: 0, state: "waiting", count: 2, awaiting: "waiting on a permission prompt" },
  ]);
});

test("pending feedback is counted per ticket and per agent it has to reach", () => {
  const b = batch({
    clusters: [cluster({ id: "c1", keys: ["CAP-1", "CAP-2"] }), cluster({ id: "c2", keys: ["CAP-3"] })],
    unclustered: [],
    ticketStates: {
      "CAP-1": ticketState("review", NOW, { feedbackDraft: "also the mini-cart" }),
      "CAP-2": ticketState("review", NOW, { feedbackDraft: "   " }),
      "CAP-3": ticketState("review", NOW, { feedbackDraft: "rename it" }),
    },
  });
  assert.deepEqual(feedbackPending(b), { tickets: 2, clusters: 2 });
});

test("a card marked as having unsent feedback is the one with a draft", () => {
  const b = batch({ ticketStates: { "CAP-1": ticketState("review", NOW, { feedbackDraft: "fix it" }), "CAP-2": ticketState("review") } });
  const cards = columns(b).find((c) => c.state === "review")!.cards;
  assert.equal(cards.find((c) => c.key === "CAP-1")!.feedbackPending, true);
  assert.equal(cards.find((c) => c.key === "CAP-2")!.feedbackPending, false);
});

test("how long a card has been where it is, in words", () => {
  assert.equal(sinceLabel(NOW - 5_000, NOW), "just now");
  assert.equal(sinceLabel(NOW - 6 * 60_000, NOW), "6 min");
  assert.equal(sinceLabel(NOW - 3 * 3_600_000, NOW), "3 h");
  assert.equal(sinceLabel(NOW - 50 * 3_600_000, NOW), "2 d");
  assert.equal(sinceLabel(null, NOW), "not started");
});

// ---- The chip's skills line ----
//
// What a cluster started with is the first question asked of a report that
// reads oddly, and by then the picker that chose it is long gone. These pin
// the two cases a label is easiest to get wrong: a name that exists twice
// under different origins, and a skill that was named but never found.
function skill(patch: Partial<SkillRecord> = {}): SkillRecord {
  return { name: "shopify-qa", dir: "/s/shopify-qa", origin: "yours", missing: false, wanted: "", ...patch };
}

test("both halves carry their origin, so two same-named skills do not read alike", () => {
  const mine = skillsLabel({
    execution: skill({ name: "execute-jira-ticket", origin: "yours" }),
    qa: skill({ origin: "yours" }),
    execFallback: false,
  });
  const theirs = skillsLabel({
    execution: skill({ name: "execute-jira-ticket", origin: "this repo" }),
    qa: skill({ origin: "this repo" }),
    execFallback: false,
  });
  assert.equal(mine, "Skills: execute-jira-ticket (yours) + shopify-qa (yours)");
  assert.equal(theirs, "Skills: execute-jira-ticket (this repo) + shopify-qa (this repo)");
  assert.notEqual(mine, theirs, "the origin is the only thing telling these two runs apart");
});

test("a skill that was named but not found says so, and says which one", () => {
  const label = skillsLabel({
    execution: skill({ name: "", dir: "", origin: "", missing: true, wanted: "/gone/my-skill" }),
    qa: skill({ name: "jira-batch-qa", origin: "the extension's default" }),
    execFallback: false,
  });
  assert.equal(label, "Skills: /gone/my-skill (not found) + jira-batch-qa (the extension's default)");
  assert.equal(label.includes("Skills:  +"), false, "an empty name reads as a rendering bug, not as a missing skill");
});

test("an empty execution slot tells the two reasons for being empty apart", () => {
  assert.match(skillsLabel({ execution: null, qa: skill(), execFallback: true }), /the brief's own steps/);
  assert.match(skillsLabel({ execution: null, qa: skill(), execFallback: false }), /the agent's judgement/);
});

test("a cluster nobody has started yet has no skills line at all", () => {
  assert.equal(skillsLabel({ execution: null, qa: null, execFallback: false }), "");
  assert.equal(skillsLabel(null), "");
});

test("QA left to the agent is said, not left blank", () => {
  assert.equal(
    skillsLabel({ execution: skill({ name: "execute-jira-ticket" }), qa: null, execFallback: false }),
    "Skills: execute-jira-ticket (yours) + no QA skill",
  );
});


// ---- The QA branch, as the board draws it ----

function qaBatch(): Batch {
  const ticket = (key: string, state: string, integration: string, extra: Record<string, unknown> = {}) => ({
    state,
    clusterId: "cls_1",
    since: 1,
    history: [],
    summary: "",
    reason: "",
    feedbackDraft: "",
    feedback: [],
    qa: null,
    qaHistory: [],
    integration: { state: integration, commit: "", change: "", fixed: "", note: "", refinedNote: "", postedNote: "", why: "", files: [], handoff: null, at: null, ...extra },
  });
  return {
    id: "bat_1",
    name: "B",
    tickets: {
      "CAP-1": { key: "CAP-1", summary: "one", priority: "Low", type: "", url: "", projectKey: "CAP" },
      "CAP-2": { key: "CAP-2", summary: "two", priority: "Highest", type: "", url: "", projectKey: "CAP" },
      "CAP-3": { key: "CAP-3", summary: "three", priority: "Weird", type: "", url: "", projectKey: "CAP" },
      "CAP-4": { key: "CAP-4", summary: "four", priority: "High", type: "", url: "", projectKey: "CAP" },
      "CAP-5": { key: "CAP-5", summary: "five", priority: "High", type: "", url: "", projectKey: "CAP" },
      "CAP-6": { key: "CAP-6", summary: "six", priority: "High", type: "", url: "", projectKey: "CAP" },
    },
    clusters: [{ id: "cls_1", name: "One", color: 2, keys: ["CAP-1", "CAP-2", "CAP-3", "CAP-4", "CAP-5", "CAP-6"], state: "running" }],
    ticketStates: {
      "CAP-1": ticket("CAP-1", "review", "none"),
      "CAP-2": ticket("CAP-2", "review", "none"),
      "CAP-3": ticket("CAP-3", "review", "none"),
      "CAP-4": ticket("CAP-4", "review", "fixing", { change: "hover resize" }),
      "CAP-5": ticket("CAP-5", "done", "approved", { postedNote: "image is FPO" }),
      "CAP-6": ticket("CAP-6", "in-progress", "none"),
    },
    qa: { state: "running", branch: "qa/b" },
  } as unknown as Batch;
}

test("the queue matches the server's order: priority rank, then key, unknown priorities last", () => {
  assert.deepEqual(qaQueue(qaBatch()), ["CAP-2", "CAP-1", "CAP-3"]);
});

test("ship blockers are the tickets on the branch nobody has passed judgement on", () => {
  assert.deepEqual(shipBlockers(qaBatch()), ["CAP-4"]);
});

test("every ticket lands in exactly one QA column, and a working one is 'not yet reviewed' rather than missing", () => {
  const columns = qaColumns(qaBatch());
  const placed = columns.flatMap((column) => column.cards.map((card) => card.key)).sort();
  assert.deepEqual(placed, ["CAP-1", "CAP-2", "CAP-3", "CAP-4", "CAP-5", "CAP-6"]);
  const by = Object.fromEntries(columns.map((column) => [column.id, column.cards.map((card) => card.key)]));
  assert.deepEqual(by.waiting, ["CAP-6"]);
  assert.deepEqual(by.queue, ["CAP-2", "CAP-1", "CAP-3"]);
  assert.deepEqual(by.verifying, ["CAP-4"]);
  assert.deepEqual(by.approved, ["CAP-5"]);
});

test("a card carries the detail its column needs: the change being fixed, the note that was posted", () => {
  const columns = qaColumns(qaBatch());
  const fixing = columns.find((column) => column.id === "verifying")!.cards[0];
  assert.equal(fixing.detail, "hover resize");
  const approved = columns.find((column) => column.id === "approved")!.cards[0];
  assert.equal(approved.detail, "image is FPO");
});
