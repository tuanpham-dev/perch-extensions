// The extension's server-sent-events streams (/batches/events,
// /reviews/events). Through the host's ctx.serverEventSource where Perch
// offers it: one connection per stream for every Perch window, where an
// EventSource per window would take two of the browser's six connections per
// origin (plain HTTP/1.1) in each window, and a second or third window would
// leave every other request waiting in the browser's queue. Older Perch
// versions lack it, so a plain EventSource remains the fallback.

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

const API_BASE = "/api/ext/perch.jira";

let hostOpener: ((path: string) => EventSourceLike) | null = null;

export function setServerEventSource(opener: ((path: string) => EventSourceLike) | null): void {
  hostOpener = opener;
}

// `path` is relative to the extension's own routes, e.g. "/batches/events".
export function openServerEvents(path: string): EventSourceLike {
  return hostOpener ? hostOpener(path) : new EventSource(`${API_BASE}${path}`);
}
