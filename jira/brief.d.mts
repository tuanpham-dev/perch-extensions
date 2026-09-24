// Types for brief.mjs, which is plain ESM so server.js can import it too.
// The client's typecheck resolves "../brief.mjs" to this file.
import type { IssueDetail } from "./src/types.ts";

export declare function buildAgentBrief(detail: IssueDetail): string;
export declare function buildCombinedBrief(details: IssueDetail[]): string;

export interface ClusterBriefInput {
  batchName: string;
  clusterName: string;
  criteria: string;
  rationale: string;
  files?: string[];
  details: IssueDetail[];
}
export declare function buildClusterBrief(input: ClusterBriefInput): string;

export interface AdditionalTicketsInput {
  clusterName: string;
  details: IssueDetail[];
}
export declare function buildAdditionalTicketsMessage(input: AdditionalTicketsInput): string;

export interface FeedbackItem {
  key: string;
  summary: string;
  feedback: string;
}
export declare function buildFeedbackMessage(input: { clusterName: string; items: FeedbackItem[] }): string;

export interface RemainingTicket {
  key: string;
  summary: string;
  state: string;
}
export declare function buildResumeMessage(input: { clusterName: string; remaining: RemainingTicket[] }): string;
