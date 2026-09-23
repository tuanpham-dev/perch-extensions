// The hook reducer's rules, pinned. They are Orca's (read from its source, not
// guessed), so each case names the situation it protects rather than the
// mapping it asserts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyFromHook,
  classifyQuiet,
  notificationContent,
  notificationContext,
  notificationFor,
  reduceHookEvent,
  STALE_AFTER_MS,
  toolInputPreview,
} from "../hookStatus.mjs";

const at = 1_000_000;
const ev = (event: string, payload: unknown = {}, receivedAt = at) => ({ event, payload, receivedAt, paneId: "%1" });

test("a resumed session lands idle, not spinning", () => {
  // SessionStart is the only event a resumed session sends before its first
  // prompt; "working" would spin over an idle TUI forever.
  const r = reduceHookEvent(undefined, ev("session-start", { source: "resume" }));
  assert.equal(r?.state, "done");
  assert.equal(r?.sessionBoundary, true);
});

test("a compaction mid-turn does not end the turn", () => {
  // Claude fires SessionStart with source "compact" while it is still working.
  const working = reduceHookEvent(undefined, ev("prompt-submit", { prompt: "go" }));
  assert.equal(reduceHookEvent(working, ev("session-start", { source: "compact" })), null);
  assert.equal(reduceHookEvent(working, ev("session-start", { source: "clear" }))?.state, "done");
});

test("a prompt starts a turn and is remembered across it", () => {
  const started = reduceHookEvent(undefined, ev("prompt-submit", { prompt: "fix the   flaky test\n please" }));
  assert.equal(started?.state, "working");
  assert.equal(started?.prompt, "fix the flaky test please");
  const tool = reduceHookEvent(started, ev("tool-start", { tool_name: "Bash" }));
  assert.equal(tool?.prompt, "fix the flaky test please", "the prompt survives later tool events");
  assert.equal(tool?.toolName, "Bash");
});

test("a tool call means working, and the tool is named", () => {
  const r = reduceHookEvent(undefined, ev("tool-start", { tool_name: "Read" }));
  assert.equal(r?.state, "working");
  assert.equal(r?.toolName, "Read");
  const ended = reduceHookEvent(r, ev("tool-end", { tool_name: "Read" }));
  assert.equal(ended?.state, "working");
  assert.equal(ended?.toolName, undefined, "nothing is in flight after the tool ends");
});

test("the agent asking the user a question is a wait, whichever channel reports it", () => {
  // Claude: AskUserQuestion arrives as PreToolUse on older builds and as
  // PermissionRequest on newer ones. Codex: request_user_input is auto-allowed
  // and so arrives as PreToolUse while blocked on a human.
  for (const [event, tool] of [
    ["tool-start", "AskUserQuestion"],
    ["permission", "AskUserQuestion"],
    ["tool-start", "request_user_input"],
  ] as const) {
    const r = reduceHookEvent(undefined, ev(event, { tool_name: tool }));
    assert.equal(r?.state, "waiting", `${event}/${tool}`);
    assert.equal(r?.detail, "question", `${event}/${tool}`);
  }
});

test("a permission prompt is a wait that names the tool", () => {
  const r = reduceHookEvent(undefined, ev("permission", { tool_name: "Bash", tool_input: { command: "rm -rf" } }));
  assert.equal(r?.state, "waiting");
  assert.equal(r?.detail, "permission");
  assert.equal(r?.toolName, "Bash");
});

test("stop is done, and a cancelled turn says so", () => {
  assert.equal(reduceHookEvent(undefined, ev("stop"))?.interrupted, undefined);
  assert.equal(reduceHookEvent(undefined, ev("stop", { is_interrupt: true }))?.interrupted, true);
  assert.equal(reduceHookEvent(undefined, ev("stop", { is_interrupt: true }))?.state, "done");
});

test("an event the reducer does not act on leaves the record alone", () => {
  assert.equal(reduceHookEvent({ state: "working", at }, ev("subagent-stop")), null);
  assert.equal(reduceHookEvent(undefined, ev("something-new")), null);
});

test("a payload that is not an object never throws", () => {
  for (const payload of [null, "text", 42, [], undefined]) {
    assert.equal(reduceHookEvent(undefined, ev("tool-start", payload))?.state, "working");
  }
});

test("prompt and tool name are single-line and bounded", () => {
  const long = "x".repeat(500);
  const r = reduceHookEvent(undefined, ev("prompt-submit", { prompt: `${long}\n\n${long}` }));
  assert.ok((r?.prompt?.length ?? 0) <= 160);
  assert.ok(!r?.prompt?.includes("\n"));
  const t = reduceHookEvent(undefined, ev("tool-start", { tool_name: long }));
  assert.ok((t?.toolName?.length ?? 0) <= 60);
});

test("hook evidence is authoritative while fresh and gone after 30 minutes", () => {
  const record = reduceHookEvent(undefined, ev("permission", { tool_name: "Bash" }));
  assert.equal(classifyFromHook(record, at + STALE_AFTER_MS)?.state, "waiting");
  assert.equal(classifyFromHook(record, at + STALE_AFTER_MS + 1), null);
  assert.equal(classifyFromHook(undefined), null);
});

test("the classification carries only what is set", () => {
  const c = classifyFromHook(reduceHookEvent(undefined, ev("stop")), at);
  assert.deepEqual(c, { state: "done", lastActivityAt: at });
  const w = classifyFromHook(reduceHookEvent(undefined, ev("permission", { tool_name: "Edit" })), at);
  assert.deepEqual(w, { state: "waiting", stateDetail: "permission", toolName: "Edit", lastActivityAt: at });
});

const threshold = 45_000;

test("with no hook, a transcript being written is working", () => {
  assert.equal(classifyQuiet(undefined, at - 1_000, threshold, at).state, "working");
  // A stale hook record never outranks a transcript still being written.
  const stale = reduceHookEvent(undefined, ev("stop", {}, at - STALE_AFTER_MS - 1));
  assert.equal(classifyQuiet(stale, at - 1_000, threshold, at).state, "working");
});

test("with no hook, a quiet agent is done, and idle after 30 minutes", () => {
  // Not "waiting on you": without a hook a permission prompt and a finished
  // turn look the same, and every idle agent would wear the attention badge.
  assert.equal(classifyQuiet(undefined, at - threshold, threshold, at).state, "done");
  assert.equal(classifyQuiet(undefined, at - STALE_AFTER_MS, threshold, at).state, "done");
  assert.equal(classifyQuiet(undefined, at - STALE_AFTER_MS - 1, threshold, at).state, "idle");
});

test("nothing known about a pane is idle", () => {
  assert.deepEqual(classifyQuiet(undefined, null, threshold, at), { state: "idle", lastActivityAt: null });
});

test("a reported finish never decays to idle; an unfinished turn does", () => {
  const long = at - STALE_AFTER_MS * 4;
  const done = reduceHookEvent(undefined, ev("stop", {}, long));
  assert.equal(classifyQuiet(done, null, threshold, at).state, "done");
  const cancelled = reduceHookEvent(undefined, ev("stop", { is_interrupt: true }, long));
  assert.equal(classifyQuiet(cancelled, long, threshold, at).interrupted, true);
  const working = reduceHookEvent(undefined, ev("prompt-submit", { prompt: "go" }, long));
  assert.equal(classifyQuiet(working, long, threshold, at).state, "idle");
  const asking = reduceHookEvent(undefined, ev("permission", { tool_name: "Bash" }, long));
  assert.equal(classifyQuiet(asking, null, threshold, at).state, "idle");
});

test("a notification fires when an agent starts waiting on you, once", () => {
  const working = reduceHookEvent(undefined, ev("prompt-submit", { prompt: "go" }));
  const asked = reduceHookEvent(working, ev("tool-start", { tool_name: "AskUserQuestion" }));
  assert.equal(notificationFor(working, asked), "question");
  // Newer Claude builds report the same question again through permission.
  const again = reduceHookEvent(asked, ev("permission", { tool_name: "AskUserQuestion" }));
  assert.equal(notificationFor(asked, again), null);
  const perm = reduceHookEvent(working, ev("permission", { tool_name: "Bash" }));
  assert.equal(notificationFor(working, perm), "permission");
  // A second prompt for a different tool is a new thing to answer.
  const perm2 = reduceHookEvent(perm, ev("permission", { tool_name: "Edit" }));
  assert.equal(notificationFor(perm, perm2), "permission");
});

test("a finished turn notifies, an interrupted one or a session boundary does not", () => {
  const working = reduceHookEvent(undefined, ev("prompt-submit", { prompt: "go" }));
  const done = reduceHookEvent(working, ev("stop"));
  assert.equal(notificationFor(working, done), "done");
  assert.equal(notificationFor(done, reduceHookEvent(done, ev("stop"))), null);
  assert.equal(notificationFor(working, reduceHookEvent(working, ev("stop", { is_interrupt: true }))), null);
  assert.equal(notificationFor(undefined, reduceHookEvent(undefined, ev("session-start", { source: "resume" }))), null);
  assert.equal(notificationFor(undefined, working), null);
});

test("notifications read the way Orca's do", () => {
  const context = notificationContext({ project: "perch", branch: "main" });
  assert.equal(context, "perch / main");
  const working = reduceHookEvent(undefined, ev("prompt-submit", { prompt: "go" }));

  const perm = reduceHookEvent(working, ev("permission", { tool_name: "Bash", tool_input: { command: "npm test" } }));
  assert.deepEqual(notificationContent("permission", { agentLabel: "Claude Code", context, record: perm }), {
    title: "perch / main - Claude Code needs input",
    body: "Using Bash: npm test",
  });

  const done = reduceHookEvent(working, ev("stop", { last_assistant_message: "All  tests\npass." }));
  assert.deepEqual(notificationContent("done", { agentLabel: "Claude Code", context, record: done }), {
    title: "perch / main - Claude Code finished",
    body: "All tests pass.",
  });

  // Nothing to say beyond the state: the body repeats it, as Orca's does.
  const bare = reduceHookEvent(working, ev("stop"));
  assert.equal(notificationContent("done", { agentLabel: "Codex", context: "", record: bare }).body, "Codex finished.");
  assert.equal(notificationContent("done", { agentLabel: "Codex", context: "", record: bare }).title, "workspace - Codex finished");
});

test("a question's notification shows the question, not the tool's input array", () => {
  const input = { questions: [{ question: "Which database should we use?", options: [] }] };
  assert.equal(toolInputPreview("AskUserQuestion", input), "Which database should we use?");
  const asked = reduceHookEvent(undefined, ev("tool-start", { tool_name: "AskUserQuestion", tool_input: input }));
  assert.equal(
    notificationContent("question", { agentLabel: "Claude Code", context: "perch", record: asked }).body,
    "Using AskUserQuestion: Which database should we use?",
  );
});
