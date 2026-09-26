// The shapes the review routes answer with, mirroring reviewModel.mjs. Keep in
// step with the model - it is the authority, this is how the panel reads it.
export type { PrLink, PreviewLink, TicketLinks } from "../links.mjs";
export type { ReviewAction } from "../reviewModel.mjs";

export type ReviewTaskName = "code" | "qa";
export type ReviewTaskState = "running" | "reported" | "stopped" | "failed";
export type Verdict = "approve" | "request-changes" | "comment";
export type Severity = "high" | "medium" | "low";
export type ReviewQaStatus = "pass" | "fail" | "partial" | "blocked";
export type PageShot = "before-1440" | "after-1440" | "before-390" | "after-390";

export interface ReviewImage {
  ext: "png" | "jpg" | "webp";
}

export interface Finding {
  severity: Severity;
  file: string;
  line: number | null;
  text: string;
}

export interface CodeReport {
  verdict: Verdict;
  summary: string;
  findings: Finding[];
  at: number;
}

export interface QaPage {
  page: string;
  slug: string;
  images: Record<PageShot, ReviewImage | null>;
  extras: (ReviewImage & { label: string; caption: string })[];
}

export interface QaReportOfReview {
  status: ReviewQaStatus;
  checked: string[];
  wrong: string[];
  notes: string[];
  pages: QaPage[];
  at: number;
}

export interface ReviewTask<R> {
  state: ReviewTaskState;
  windowId: string;
  agentId: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  error: string;
  report: R | null;
}

export interface Review {
  key: string;
  repo: string;
  worktreePath: string;
  branch: string;
  sessionName: string;
  prUrl: string;
  previewUrl: string;
  tasks: { code: ReviewTask<CodeReport> | null; qa: ReviewTask<QaReportOfReview> | null };
  posted: { pr: { url: string; at: number } | null; jira: { at: number } | null };
  createdAt: number;
  updatedAt: number;
}

export interface ReviewDocument {
  version: number;
  reviews: Record<string, Review>;
  repoPaths: Record<string, string>;
}

export interface StartReviewResult {
  tasks: { task: ReviewTaskName; sessionName: string; windowId: string; cwd: string }[];
  worktreePath: string;
}
