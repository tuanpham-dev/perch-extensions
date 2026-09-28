// Form state that outlives the component showing it. A half-written change
// request or approval note sits in the ticket's detail pane, and that pane
// unmounts whenever the tab goes away or the view switches between Table and
// Batches - which threw the typing away with it. Kept per key in memory for
// the life of the page: a draft is a convenience for this sitting, and the
// ones that must outlive the page (the feedback draft, the refine request)
// are the server's.
import { useCallback, useState } from "react";

const drafts = new Map<string, unknown>();

export function useStickyState<T>(key: string, initial: T): [T, (next: T) => void] {
  const [, force] = useState(0);
  const value = (drafts.has(key) ? drafts.get(key) : initial) as T;
  const set = useCallback(
    (next: T) => {
      if (Object.is(next, initial)) drafts.delete(key);
      else drafts.set(key, next);
      force((n) => n + 1);
    },
    // `initial` is a literal at every call site; reading it by identity is
    // what lets "back to the initial value" forget the entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return [value, set];
}

// Forgets every draft under a prefix, e.g. once the ticket's verdict is in.
export function clearSticky(prefix: string): void {
  for (const key of [...drafts.keys()]) if (key.startsWith(prefix)) drafts.delete(key);
}

// Reads a draft without subscribing, for an action that should use what is
// on screen (a field still being edited when a button is clicked).
export function readSticky<T>(key: string): T | undefined {
  return drafts.get(key) as T | undefined;
}
