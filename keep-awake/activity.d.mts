// Types for activity.mjs, which the client shares with server.js.
export const STALE_MS: number;
export const AFTER_AGENTS_MS: number;
export const EVENTS: string[];
export function createActivity(): {
  onEvent(event: { event: string; paneId: string | null; sessionName: string | null; receivedAt: number }): void;
  read(now: number, openWindows: Set<string> | null): { working: number; idleForMs: number | null };
};
export function wantsAwake(mode: string, activity: { working: number; idleForMs: number | null }): boolean;
