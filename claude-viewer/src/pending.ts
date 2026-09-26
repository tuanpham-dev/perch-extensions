// A message the tab has sent to the pane but hasn't seen come back in the
// transcript yet. Claude Code writes a message into the transcript when it
// starts the turn it belongs to; one sent mid-run is only recorded alongside
// the next tool result (see the server's queuedHumanMessage), which can be
// many seconds - or a long build - later. Until then the conversation showed
// nothing at all, so the tab looked like it had swallowed the message.
//
// So the tab keeps its own copy and shows it, marked, until the real entry
// arrives and takes its place.

import type { ChatItem } from "./chatModel.ts";

export type PendingMessage = {
  key: string;
  text: string;
  // Item count with this exact text when the message was sent, so a message
  // resolves against its OWN transcript entry: sending the same text twice
  // needs two entries before both bubbles go, and an earlier identical
  // message in the conversation doesn't resolve either of them.
  seen: number;
  sentAt: number;
  // When to stop waiting for it (see timeoutFor).
  timeout: number;
};

// A pending message nothing ever claims (sent to a pane that isn't Claude,
// a run abandoned mid-turn) would sit in the conversation forever. Long
// enough that a slow tool call doesn't drop a real one early.
export const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

// A slash command or `!` shell command sent while Claude is idle runs at
// once, and many of them (/help, /config, /model with no argument, a picker
// you close) never write anything to the transcript. So one that hasn't
// shown up within a couple of polls isn't going to.
export const COMMAND_TIMEOUT_MS = 5 * 1000;

export function isCommandText(text: string): boolean {
  return /^[/!]/.test(text.trim());
}

export function timeoutFor(text: string, working: boolean): number {
  return isCommandText(text) && !working ? COMMAND_TIMEOUT_MS : PENDING_TIMEOUT_MS;
}

// The transcript entry `text` comes back as. A slash command is recorded as
// its name and arguments ("/model" + "opus"), a shell command as "!" + the
// command, so a command bubble is matched against those, not user text. A
// command queued while Claude works comes back as the text as typed, which
// the user-text match covers.
function echoes(item: ChatItem, text: string): boolean {
  if (item.kind === "text") return item.role === "user" && item.text === text;
  if (item.kind !== "command") return false;
  const t = text.trim();
  if (t.startsWith("!")) return item.command === "!" && item.args === t.slice(1).trim();
  const m = /^(\/\S+)\s*([\s\S]*)$/.exec(t);
  return m !== null && item.command === m[1] && item.args === m[2].trim();
}

export function countEchoes(items: ChatItem[], text: string): number {
  let n = 0;
  for (const item of items) {
    if (echoes(item, text)) n++;
  }
  return n;
}

// `seen` counts the pending copies too, so sending the same text twice in a
// row gives the second bubble a higher bar than the first: one arriving entry
// then resolves one bubble, not both.
export function createPending(
  items: ChatItem[],
  pending: PendingMessage[],
  text: string,
  key: string,
  now: number,
  working = true,
): PendingMessage {
  const alreadyPending = pending.filter((p) => p.text === text).length;
  return { key, text, seen: countEchoes(items, text) + alreadyPending, sentAt: now, timeout: timeoutFor(text, working) };
}

/** Drops each pending message the transcript has caught up with, or given up on. */
export function resolvePending(pending: PendingMessage[], items: ChatItem[], now: number): PendingMessage[] {
  if (pending.length === 0) return pending;
  const kept = pending.filter(
    (p) => now - p.sentAt < p.timeout && countEchoes(items, p.text) <= p.seen,
  );
  return kept.length === pending.length ? pending : kept;
}

/** The rows the list draws after the transcript's own items. */
export function pendingItems(pending: PendingMessage[]): ChatItem[] {
  return pending.map((p) => ({ kind: "text", role: "user", text: p.text, pending: true, key: p.key }) as ChatItem);
}
