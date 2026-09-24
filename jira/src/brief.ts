// The briefs live in ../brief.mjs, outside src/, because server.js needs them
// too and the host loads it as plain JS with no TypeScript loader. This file
// is the client's door to them, so every import inside src/ keeps reading
// "./brief" and the bundler pulls in the one implementation.
export {
  buildAdditionalTicketsMessage,
  buildAgentBrief,
  buildClusterBrief,
  buildCombinedBrief,
  buildFeedbackMessage,
  buildResumeMessage,
} from "../brief.mjs";
export type {
  AdditionalTicketsInput,
  ClusterBriefInput,
  FeedbackItem,
  RemainingTicket,
} from "../brief.mjs";
