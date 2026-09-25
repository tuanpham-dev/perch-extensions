// One function per batch route, and the event stream the board listens on.
//
// Every mutating call answers with the whole batch, so the caller replaces
// what it is holding rather than patching it - the server computes each
// cluster's state and allowed actions, and a client that tried to keep up by
// applying deltas would eventually disagree with it.
import { apiGet, apiPost } from "./api";
import type {
  AiProfilesResponse,
  AnalyzeResponse,
  ApplyResponse,
  BatchListResponse,
  BatchResponse,
  ClusterActionResponse,
  FeedbackResponse,
  Proposal,
  SkillsResponse,
  StartResponse,
 QaStartResponse } from "./batchTypes";
import type { LookupResponse } from "./batchTypes";

export function lookupIssues(keys: string[] | string): Promise<LookupResponse> {
  return apiPost<LookupResponse>("/issues/lookup", { keys });
}

export function listBatches(cwd: string): Promise<BatchListResponse> {
  return apiGet<BatchListResponse>(`/batches?cwd=${encodeURIComponent(cwd)}`);
}

export function getBatch(id: string): Promise<BatchResponse> {
  return apiGet<BatchResponse>(`/batches/${encodeURIComponent(id)}`);
}

export function getBadge(): Promise<{ badge: number }> {
  return apiGet<{ badge: number }>("/batches/badge");
}

export function listSkills(cwd: string): Promise<SkillsResponse> {
  return apiGet<SkillsResponse>(`/skills?cwd=${encodeURIComponent(cwd)}`);
}

// Copying the bundled QA skill into the user's own directory. `force` is
// their answer to a skill of that name already being there.
export function installBundledQaSkill(force: boolean): Promise<{ ok: boolean; existed: boolean; dir: string; target: string }> {
  return apiPost("/skills/install-qa", { force });
}

export function listAiProfiles(): Promise<AiProfilesResponse> {
  return apiGet<AiProfilesResponse>("/ai-profiles");
}

export function analyzeBatch(body: {
  cwd: string;
  keys: string[];
  criteria: string;
  readCodebase: boolean;
  // Skip the AI: one cluster holding every ticket.
  single?: boolean;
  batchId?: string | null;
}): Promise<AnalyzeResponse> {
  return apiPost<AnalyzeResponse>("/batches/analyze", body);
}

export function applyProposal(id: string, proposal?: Proposal): Promise<ApplyResponse> {
  return apiPost<ApplyResponse>(`/batches/${encodeURIComponent(id)}/apply`, proposal ? { proposal } : {});
}

export function saveClusters(id: string, proposal: Proposal): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/clusters`, { proposal });
}

export function renameBatch(id: string, name: string): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/rename`, { name });
}

export function renameCluster(id: string, clusterId: string, name: string): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/clusters/${encodeURIComponent(clusterId)}/rename`, { name });
}

export function setClusterBranch(id: string, clusterId: string, branch: string): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/clusters/${encodeURIComponent(clusterId)}/branch`, { branch });
}

export function addCluster(id: string, name: string): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/clusters/add`, { name });
}

export function removeCluster(id: string, clusterId: string): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/clusters/${encodeURIComponent(clusterId)}/remove`, {});
}

// ---- The QA branch ----

export function startQa(id: string, agentId?: string): Promise<QaStartResponse> {
  return apiPost<QaStartResponse>(`/batches/${encodeURIComponent(id)}/qa/start`, agentId ? { agentId } : {});
}

export function qaMerge(id: string, key: string): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/qa/merge`, { key });
}

export function qaChange(id: string, key: string, change: string): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/qa/change`, { key, change });
}

export function qaApprove(
  id: string,
  key: string,
  notes: { note: string; refinedNote: string; postedNote: string },
): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/qa/approve`, { key, ...notes });
}

export function qaExclude(id: string, key: string, why: string): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/qa/exclude`, { key, why });
}

export function qaShip(id: string): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/qa/ship`, {});
}

// The note as a teammate will read it. `asWritten` means the model could not
// restate it without guessing, so the original is offered back unchanged.
export function qaRefineNote(id: string, key: string, note: string): Promise<{ refined: string; asWritten: boolean }> {
  return apiPost<{ refined: string; asWritten: boolean }>(`/batches/${encodeURIComponent(id)}/qa/refine-note`, { key, note });
}

export function qaHandoff(id: string): Promise<BatchResponse & { results: { key: string; ok: boolean; error: string }[] }> {
  return apiPost(`/batches/${encodeURIComponent(id)}/qa/handoff`, {});
}

export function moveTicket(id: string, key: string, clusterId: string | null, index: number): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/move`, { key, clusterId, index });
}

export function startClusters(
  id: string,
  clusterIds: string[],
  agentId: string,
  branches: Record<string, string>,
  // Per-cluster overrides of the Settings choice, for this run only.
  skills?: { execution?: string; qa?: string },
): Promise<StartResponse> {
  return apiPost<StartResponse>(`/batches/${encodeURIComponent(id)}/start`, { clusterIds, agentId, branches, skills });
}

export function clusterAction(
  id: string,
  clusterId: string,
  action: "stop" | "resume" | "close" | "remove-worktree",
  body: Record<string, unknown> = {},
): Promise<ClusterActionResponse> {
  return apiPost<ClusterActionResponse>(
    `/batches/${encodeURIComponent(id)}/clusters/${encodeURIComponent(clusterId)}/${action}`,
    body,
  );
}

export function rebuildReport(id: string, clusterId: string): Promise<BatchResponse & { result: { specPath: string; reportPath: string } }> {
  return apiPost(`/batches/${encodeURIComponent(id)}/clusters/${encodeURIComponent(clusterId)}/rebuild-report`, {});
}

export function saveFeedbackDraft(id: string, key: string, text: string): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/tickets/${encodeURIComponent(key)}/feedback`, { text });
}

export function acceptTicket(id: string, key: string): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/tickets/${encodeURIComponent(key)}/accept`, {});
}

export function sendFeedback(id: string): Promise<FeedbackResponse> {
  return apiPost<FeedbackResponse>(`/batches/${encodeURIComponent(id)}/send-feedback`, {});
}

export function archiveBatch(id: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/batches/${encodeURIComponent(id)}/archive`, {});
}

export function unarchiveBatch(id: string): Promise<BatchResponse> {
  return apiPost<BatchResponse>(`/batches/${encodeURIComponent(id)}/unarchive`, {});
}

export function deleteBatch(id: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/batches/${encodeURIComponent(id)}/delete`, {});
}

// ---- The event stream ----
//
// EventSource rather than the extension's serverFetch: it is a GET with no
// body, it reconnects on its own, and the host's fetch wrapper has nothing to
// add to it. The path is the extension's own route, same origin.
//
// EventSource retries by itself, but only while the server is merely slow; a
// connection the browser gives up on (a server restart) needs a new one, and
// a backoff so a server that stays down is not hammered. `onReconnect` is how
// the board refetches after a gap, since events that happened while the
// stream was down were never delivered.
const EVENTS_URL = "/api/ext/perch.jira/batches/events";
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export function subscribeBatchEvents(
  onChange: (batchId: string) => void,
  onReconnect?: () => void,
): () => void {
  let source: EventSource | null = null;
  let retry = MIN_RETRY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let everOpened = false;

  const connect = () => {
    if (stopped) return;
    source = new EventSource(EVENTS_URL);
    source.addEventListener("open", () => {
      retry = MIN_RETRY_MS;
      // Not on the first connection: the caller has just loaded the batch.
      if (everOpened) onReconnect?.();
      everOpened = true;
    });
    source.addEventListener("batch-changed", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        if (typeof data?.batchId === "string") onChange(data.batchId);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    });
    source.addEventListener("error", () => {
      source?.close();
      source = null;
      if (stopped) return;
      timer = setTimeout(connect, retry);
      retry = Math.min(MAX_RETRY_MS, retry * 2);
    });
  };

  connect();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    source?.close();
    source = null;
  };
}
