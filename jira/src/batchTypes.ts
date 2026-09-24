// The shapes the batch routes answer with, mirroring what batchModel.mjs
// stores and what server.js's decorate() adds on top. Structural copies, the
// same way types.ts copies the rest of the API: the model is plain .mjs, so
// there is nothing to import a type from.
//
// Keep these in step with batchModel.mjs - the model is the authority, this
// is how the client reads it.

export type TicketStateName =
  | "queued"
  | "in-progress"
  | "needs-you"
  | "review"
  | "rework"
  | "done"
  | "failed";

export type ClusterStateName = "pending" | "running" | "waiting" | "idle" | "stopped" | "closed";

export type ClusterAction = "start" | "open" | "stop" | "resume" | "close" | "remove-worktree";

export interface BatchTicket {
  key: string;
  summary: string;
  type: string;
  priority: string;
  url: string;
  projectKey: string;
}

export interface TicketHistoryEntry {
  state: TicketStateName;
  at: number;
  note: string;
}

export interface SentFeedback {
  text: string;
  sentAt: number;
}

// What a QA pass concluded, in qa-report's own vocabulary so a status means
// the same thing here, in the assembled spec and in the rendered HTML.
export type QaStatus = "pass" | "fail" | "partial" | "blocked" | "unverified";

export interface QaImage {
  ext: string;
  at: number;
}

export interface QaReport {
  status: QaStatus;
  problem: string[];
  fix: string[];
  steps: string[];
  notes: string[];
  files: string[];
  // Presence only - the bytes are fetched from the extension's own route, so
  // the panel keeps them after the worktree is gone.
  before: QaImage | null;
  after: QaImage | null;
  // The user's own rendered report, where they left it.
  reportPath: string;
  at: number;
}

export interface TicketState {
  state: TicketStateName;
  clusterId: string;
  since: number;
  history: TicketHistoryEntry[];
  // The agent's own words on what it did, or why it could not.
  summary: string;
  reason: string;
  feedbackDraft: string;
  feedback: SentFeedback[];
  qa: QaReport | null;
  qaHistory: QaReport[];
}

export interface ClusterNote {
  text: string;
  at: number;
}

export interface Cluster {
  id: string;
  name: string;
  rationale: string;
  files: string[];
  color: number;
  keys: string[];
  branch: string;
  worktreePath: string;
  worktreeRemovedAt: number | null;
  sessionName: string;
  windowId: string;
  agentId: string;
  // What the panel draws: the derived state (waiting and idle included).
  state: ClusterStateName;
  // What the runner stored, before the tickets are taken into account. Shown
  // nowhere; useful when a state reads oddly and you are looking at the wire.
  storedState: ClusterStateName;
  actions: ClusterAction[];
  working: string | null;
  startedAt: number | null;
  stoppedReason: string;
  lastError: string;
  lastEventAt: number | null;
  awaiting: string | null;
  notes: ClusterNote[];
  // What this cluster started with, so a report traces to the procedure that
  // produced it. Null in a slot means the agent's own judgement.
  skills: {
    execution: SkillRecord | null;
    qa: SkillRecord | null;
    execFallback: boolean;
  };
  qaSpecPath: string;
  qaReportPath: string;
}

export interface SkillRecord {
  name: string;
  dir: string;
  origin: string;
  missing: boolean;
  wanted: string;
}

export interface ProposalCluster {
  id: string | null;
  name: string;
  rationale: string;
  files: string[];
  keys: string[];
}

export interface Proposal {
  clusters: ProposalCluster[];
  unclustered: string[];
  // Present on a pending (add-to-batch) proposal only.
  keys?: string[];
  heuristic?: boolean;
  warnings?: string[];
}

export interface Batch {
  id: string;
  name: string;
  repo: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  criteria: string;
  readCodebase: boolean;
  agentId: string;
  tickets: Record<string, BatchTicket>;
  clusters: Cluster[];
  ticketStates: Record<string, TicketState>;
  unclustered: string[];
  pendingProposal: Proposal | null;
  counts: Record<TicketStateName, number>;
  pendingFeedback: number;
  canArchive: boolean;
  canDelete: boolean;
}

export interface BatchSummary {
  id: string;
  name: string;
  repo: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  counts: Record<TicketStateName, number>;
  clusters: { id: string; name: string; color: number; state: ClusterStateName }[];
  pendingFeedback: number;
}

export interface BatchListResponse {
  batches: BatchSummary[];
  archived: BatchSummary[];
}

export interface AnalyzeResponse {
  batchId: string;
  batch: Batch;
  warnings: string[];
  heuristic: boolean;
  addOnly: boolean;
}

export interface BatchResponse {
  batch: Batch;
  warnings?: string[];
}

export interface StartResponse extends BatchResponse {
  started: { clusterId: string; worktreePath: string; sessionName: string; note: string | null }[];
  failed: { clusterId: string; error: string; status: number }[];
}

export interface FeedbackResponse extends BatchResponse {
  sent: { clusterId: string; clusterName: string; keys: string[] }[];
  skipped: { clusterId: string; clusterName: string; reason: string; keys: string[] }[];
}

export interface ApplyResponse extends BatchResponse {
  handovers: { clusterId: string; keys: string[] }[];
}

export interface ClusterActionResponse extends BatchResponse {
  result: { clusterId: string; removed?: boolean; dirty?: boolean; error?: string };
}

// GET /skills. What the pickers offer; the extension locates skills and
// never reads one.
export interface SkillSummary {
  dir: string;
  name: string;
  description: string;
  origin: string;
}

export interface SkillsResponse {
  skills: SkillSummary[];
  defaults: { execution: string; qa: string };
}

// GET /ai-profiles. Only a CLI agent can read the repository, so the form's
// "Read the codebase" choice needs to know which kind answers.
export interface AiProfileSummary {
  id: string;
  label: string;
  provider: string;
  program: string;
  model: string;
  isDefault: boolean;
}

export interface AiProfilesResponse {
  profiles: AiProfileSummary[];
  supported: boolean;
  error?: string;
}

// POST /issues/lookup.
export interface LookupResponse {
  found: import("./types.ts").IssueRow[];
  missing: string[];
  invalid: string[];
}
