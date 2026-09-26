// Types for the part of reviewModel.mjs the client uses.
import type { TicketLinks } from "./links.mjs";

export type ReviewAction = "code" | "qa" | "both";
export declare const ACTIONS: ReviewAction[];
export declare function enabledActions(links: TicketLinks | null | undefined): Record<ReviewAction, boolean>;
export declare function effectiveAction(links: TicketLinks | null | undefined, saved: unknown): ReviewAction | null;
export declare function tasksFor(action: ReviewAction): ("code" | "qa")[];
