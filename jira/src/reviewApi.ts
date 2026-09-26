// The review routes, and their event stream. Same conventions as batchApi.ts.
import { apiGet, apiPost } from "./api";
import type { ReviewDocument, ReviewTaskName, StartReviewResult } from "./reviewTypes";

const BASE = "/reviews";

export function fetchReviews(): Promise<ReviewDocument> {
  return apiGet<ReviewDocument>(BASE);
}

export interface StartReviewBody {
  tasks: ReviewTaskName[];
  prUrl?: string;
  previewUrl?: string;
  agentId?: string;
  cwd?: string | null;
  repoPath?: string;
}

// Rejects with an error whose `body.needsRepo` is { owner, repo } when the
// pull request's repository is not checked out anywhere perch knows.
export function startReview(key: string, body: StartReviewBody): Promise<StartReviewResult> {
  return apiPost<StartReviewResult>(`${BASE}/${encodeURIComponent(key)}/start`, body);
}

export function stopReviewTask(key: string, task: ReviewTaskName): Promise<unknown> {
  return apiPost(`${BASE}/${encodeURIComponent(key)}/stop`, { task });
}

export function closeReviewOf(key: string): Promise<unknown> {
  return apiPost(`${BASE}/${encodeURIComponent(key)}/close`, {});
}

export function postReviewToPr(key: string, again: boolean): Promise<{ url: string }> {
  return apiPost<{ url: string }>(`${BASE}/${encodeURIComponent(key)}/post-pr`, { again });
}

export function postReviewToJira(key: string, again: boolean, perchUrl: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`${BASE}/${encodeURIComponent(key)}/post-jira`, { again, perchUrl });
}

export function reviewShotSrc(key: string, slug: string, which: string): string {
  return `/api/ext/perch.jira/review-shots/${encodeURIComponent(key)}/${encodeURIComponent(slug)}/${encodeURIComponent(which)}`;
}

export function storefrontPasswordSet(project: string): Promise<{ set: boolean; supported: boolean }> {
  return apiGet(`/storefront-password?project=${encodeURIComponent(project)}`);
}

// ---- The event stream ----
// A copy of batchApi's subscription, for /reviews/events. Two streams rather
// than one shared, so neither flow's route or event names leak into the other.
const EVENTS_URL = "/api/ext/perch.jira/reviews/events";
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export function subscribeReviewEvents(onChange: (key: string) => void, onReconnect?: () => void): () => void {
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
      if (everOpened) onReconnect?.();
      everOpened = true;
    });
    source.addEventListener("review-changed", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        if (typeof data?.key === "string") onChange(data.key);
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
  };
}
