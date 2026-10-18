// Unsaved edits, backed up through the host's server-side drafts store
// (ctx.drafts) so a page reload, a browser crash or an extension update
// doesn't take them with it, and a tab reopened on another device picks them
// up — VS Code's "hot exit". A backup records the edited text plus a hash of
// the on-disk text the edits started from, so a restore can tell whether the
// file has moved on underneath them.
//
// A host older than ctx.drafts has none of this: every call is a no-op and
// edits live only as long as the tab, as they always did. Failures are
// swallowed for the same reason — a backup that can't be written must never
// break editing itself.

export interface Backup {
  text: string;
  /** hashText() of the on-disk content the edits were made against. */
  base: string;
}

export interface DraftsApi {
  get(key: string): Promise<{ value: unknown; savedAt: number } | null>;
  set(key: string, value: unknown, opts?: { keepalive?: boolean }): Promise<void>;
  delete(key: string, opts?: { keepalive?: boolean }): Promise<void>;
}

let drafts: DraftsApi | null = null;

export function setDraftsApi(api: DraftsApi | null): void {
  drafts = api;
}

// FNV-1a over UTF-16 code units, plus the length — only ever compared for
// equality against another hash of the same file, so 32 bits is plenty.
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}:${(h >>> 0).toString(16)}`;
}

// One chain per file, so requests reach the server in the order they were
// issued: a slow write landing after the delete that followed a save would
// otherwise resurrect edits that are already on disk.
const queues = new Map<string, Promise<void>>();

function enqueue(filePath: string, op: () => Promise<void>): void {
  const next = (queues.get(filePath) ?? Promise.resolve()).then(op).catch(() => {});
  queues.set(filePath, next);
  void next.then(() => {
    if (queues.get(filePath) === next) queues.delete(filePath);
  });
}

export async function readBackup(filePath: string): Promise<Backup | null> {
  if (!drafts) return null;
  // A reopen right after a close must see that close's delete, not race it.
  await queues.get(filePath);
  try {
    const stored = await drafts.get(filePath);
    const value = stored?.value as Partial<Backup> | undefined;
    if (typeof value?.text !== "string" || typeof value.base !== "string") return null;
    return { text: value.text, base: value.base };
  } catch {
    return null;
  }
}

export function writeBackup(filePath: string, text: string, baseText: string, opts?: { keepalive?: boolean }): void {
  const api = drafts;
  if (!api) return;
  const backup: Backup = { text, base: hashText(baseText) };
  // From pagehide: sent at once, since a queued request would start after
  // the page is gone. Nothing issued later can overtake it.
  if (opts?.keepalive) void api.set(filePath, backup, opts).catch(() => {});
  else enqueue(filePath, () => api.set(filePath, backup));
}

export function clearBackup(filePath: string, opts?: { keepalive?: boolean }): void {
  const api = drafts;
  if (!api) return;
  if (opts?.keepalive) void api.delete(filePath, opts).catch(() => {});
  else enqueue(filePath, () => api.delete(filePath));
}
