// What the board draws, worked out away from the board itself: which column
// each ticket sits in, which clusters are on screen, and how long a card has
// been where it is.
//
// Pure, so src/batchViewModel.test.ts can pin the rules that are easy to get
// subtly wrong - a filter that hides a cluster added after it was set, a
// column that disappears when it empties, a card ordered by the wrong clock.
import type { Batch, Cluster, ClusterStateName, SkillRecord, TicketStateName } from "./batchTypes";

// Always all seven, in this order, however empty: a board whose columns come
// and go cannot be scanned, and "nothing in Needs you" is information.
export const COLUMNS: { state: TicketStateName; label: string }[] = [
  { state: "queued", label: "Queued" },
  { state: "in-progress", label: "In progress" },
  { state: "needs-you", label: "Needs you" },
  { state: "review", label: "Review" },
  { state: "rework", label: "Rework" },
  { state: "done", label: "Done" },
  { state: "failed", label: "Failed" },
];

export interface Card {
  key: string;
  state: TicketStateName;
  summary: string;
  clusterId: string | null;
  clusterName: string;
  color: number;
  // Null for a ticket in a cluster nobody has started: it has no state yet,
  // and the board says so rather than implying an agent has it queued.
  since: number | null;
  started: boolean;
  // The agent's summary on a reviewed ticket, its reason on a failed one.
  note: string;
  feedbackPending: boolean;
  // The QA verdict, or null when none was filed. A ticket that reached
  // Review or Failed with null is the "no QA report" case the board marks -
  // never a refusal, only a gap made visible.
  qa: string | null;
}

export interface Column {
  state: TicketStateName;
  label: string;
  cards: Card[];
}

export interface ClusterChip {
  id: string;
  name: string;
  color: number;
  state: ClusterStateName;
  count: number;
  // What it is waiting on, for the chip's tooltip.
  awaiting: string | null;
}

function clusterOfKey(batch: Batch, key: string): Cluster | null {
  return batch.clusters.find((cluster) => cluster.keys.includes(key)) ?? null;
}

// `filter` empty means every cluster - so a cluster created after a filter was
// set is never hidden by it, which is the behaviour you want when a batch
// grows under you.
function visible(filter: ReadonlySet<string>, clusterId: string | null): boolean {
  if (filter.size === 0) return true;
  return clusterId !== null && filter.has(clusterId);
}

export function columns(batch: Batch, filter: ReadonlySet<string> = new Set()): Column[] {
  const cards = new Map<TicketStateName, Card[]>(COLUMNS.map((column) => [column.state, []]));
  for (const key of Object.keys(batch.tickets)) {
    const cluster = clusterOfKey(batch, key);
    if (!visible(filter, cluster?.id ?? null)) continue;
    const ticket = batch.ticketStates[key];
    const state: TicketStateName = ticket?.state ?? "queued";
    cards.get(state)?.push({
      key,
      state,
      summary: batch.tickets[key]?.summary ?? "",
      clusterId: cluster?.id ?? null,
      clusterName: cluster?.name ?? "Unclustered",
      color: cluster?.color ?? -1,
      since: ticket?.since ?? null,
      started: Boolean(ticket),
      note: ticket ? (ticket.state === "failed" ? ticket.reason : ticket.summary) : "",
      feedbackPending: Boolean(ticket?.feedbackDraft.trim()),
      qa: ticket?.qa?.status ?? null,
    });
  }
  // Oldest first inside a column, so whatever has been sitting in Review
  // longest is the first thing you see. A ticket with no state yet has no
  // clock of its own and sorts after the ones that do, by key.
  for (const list of cards.values()) {
    list.sort((a, b) => {
      if (a.since !== null && b.since !== null) return a.since - b.since || a.key.localeCompare(b.key);
      if (a.since !== null) return -1;
      if (b.since !== null) return 1;
      return a.key.localeCompare(b.key);
    });
  }
  return COLUMNS.map((column) => ({ ...column, cards: cards.get(column.state) ?? [] }));
}

export function clusterChips(batch: Batch): ClusterChip[] {
  return batch.clusters.map((cluster) => ({
    id: cluster.id,
    name: cluster.name,
    color: cluster.color,
    state: cluster.state,
    count: cluster.keys.length,
    awaiting: cluster.awaiting,
  }));
}

// How many drafts are waiting to be sent, and to how many agents - the button
// says both, because "Send feedback (3)" reads differently when it is three
// tickets in one terminal or three terminals.
export function feedbackPending(batch: Batch): { tickets: number; clusters: number } {
  let tickets = 0;
  const clusters = new Set<string>();
  for (const [key, ticket] of Object.entries(batch.ticketStates)) {
    if (!ticket.feedbackDraft.trim()) continue;
    tickets += 1;
    const cluster = clusterOfKey(batch, key);
    if (cluster) clusters.add(cluster.id);
  }
  return { tickets, clusters: clusters.size };
}

// Coarse on purpose: a card says how long it has been where it is, not when
// it got there, and past an hour the minute stops being the point.
export function sinceLabel(since: number | null, now: number): string {
  if (since === null) return "not started";
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

// A ticket that has finished but filed no report. Only meaningful once the
// agent is done with it: a queued ticket has nothing to have reported yet.
export function missingQa(card: Card): boolean {
  return card.started && card.qa === null && (card.state === "review" || card.state === "failed");
}

// ---- What a cluster started with ----
//
// A cluster's chip says which skills its agent was actually given, because a
// report that reads oddly is usually a question about the procedure behind
// it, and the answer is not visible anywhere else once the run is under way.
//
// The origin belongs on both halves: two skills may share a name and differ
// only in where they came from - "shopify-qa (yours)" against "shopify-qa
// (this repo)" - and a label that dropped it would make those two runs look
// identical.
function slotLabel(skill: SkillRecord | null, fallback: string): string {
  if (!skill) return fallback;
  // A skill that was named but not found: say the name that was asked for,
  // not an empty string, and say that it was missing.
  if (skill.missing) return `${skill.wanted || "a skill"} (not found)`;
  return skill.origin ? `${skill.name} (${skill.origin})` : skill.name;
}

export function skillsLabel(skills: Cluster["skills"] | null | undefined): string {
  if (!skills || (!skills.execution && !skills.qa && !skills.execFallback)) return "";
  // An empty execution slot means one of two different things, and they are
  // worth telling apart: the brief carried its own short procedure, or the
  // user chose to leave that half to the agent.
  const execution = slotLabel(skills.execution, skills.execFallback ? "the brief's own steps" : "the agent's judgement");
  const qa = slotLabel(skills.qa, "no QA skill");
  return `Skills: ${execution} + ${qa}`;
}
