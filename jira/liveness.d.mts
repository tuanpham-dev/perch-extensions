// Types for liveness.mjs, plain ESM shared by the server's runners.
export declare const AGENT_EXIT_GRACE_MS: number;
export declare function isShellCommand(command: string | null | undefined): boolean;
export declare function createShellWatch(graceMs?: number): {
  observe(windowId: string, command: string, now: number): boolean;
  forget(windowId: string): void;
};
