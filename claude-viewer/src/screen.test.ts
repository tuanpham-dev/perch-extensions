// The screen parser against screens captured from Claude Code 2.1.273. Each
// fixture is one real state of the TUI; if a Claude Code update changes a
// layout, re-capture the fixture and this file says what moved.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseLetterKeys, parseScreen, promptSignature } from "../screen.mjs";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");
const parse = (name: string) => parseScreen(fixture(name));

test("reads each permission mode from the footer", () => {
  assert.equal(parse("mode-auto").mode.id, "auto");
  assert.equal(parse("mode-manual").mode.id, "manual");
  assert.equal(parse("mode-accept-edits").mode.id, "acceptEdits");
  assert.equal(parse("mode-plan").mode.id, "plan");
});

test("an unknown mode keeps its own words", () => {
  const s = parseScreen("─────────────\n❯ \n─────────────\n  ⏵⏵ turbo mode on (shift+tab to cycle)");
  assert.deepEqual(s.mode, { id: "other", label: "turbo" });
});

test("idle screen has an input box and no prompt", () => {
  const s = parse("idle");
  assert.ok(s.input);
  assert.equal(s.prompt, null);
  assert.equal(s.unmodeled, false);
  assert.equal(s.activity.state, "idle");
});

test("working line: label, elapsed and note", () => {
  const a = parse("activity-working").activity;
  assert.equal(a.state, "working");
  assert.equal(a.label, "Marinating");
  assert.equal(a.elapsed, "2s");
  assert.equal(a.note, "thinking");
});

test("working line with a hook note and a token count", () => {
  const a = parse("activity-stop-hook").activity;
  assert.equal(a.state, "working");
  assert.equal(a.elapsed, "6s");
  assert.equal(a.tokens, "307");
  assert.equal(a.note, "running Stop hook");
});

test("done line reads as idle with its summary", () => {
  const a = parse("activity-done").activity;
  assert.equal(a.state, "idle");
  assert.equal(a.verb, "Churned");
  assert.equal(a.elapsed, "6s");
});

test("Bash permission prompt", () => {
  const p = parse("permission-bash").prompt;
  assert.equal(p.kind, "permission");
  assert.equal(p.title, "Bash command");
  assert.equal(p.question, "Do you want to proceed?");
  assert.ok(p.body.some((l: string) => l.includes("date > when.txt && cat when.txt")));
  assert.equal(p.options.length, 4);
  assert.equal(p.options[0].label, "Yes");
  assert.equal(p.options[0].cursor, true);
  assert.match(p.options[1].label, /always allow access to \/tmp\/.*dc76-4802-.*cvprobe from this project$/);
  assert.equal(p.options[3].label, "No");
});

test("Write permission prompt keeps the wrapped option on one label", () => {
  const p = parse("permission-write").prompt;
  assert.equal(p.kind, "permission");
  assert.equal(p.title, "Create file");
  assert.equal(p.question, "Do you want to create notes.txt?");
  assert.equal(p.options.length, 3);
  assert.match(p.options[1].label, /for this session \(shift\+tab\)$/);
});

test("plan approval prompt with the plan body", () => {
  const p = parse("plan-approval").prompt;
  assert.equal(p.kind, "plan");
  assert.equal(p.options.length, 3);
  assert.equal(p.options[2].label, "Tell Claude what to change");
  assert.equal(p.options[2].description, "shift+tab to approve with this feedback");
  assert.ok(p.plan);
  assert.match(p.plan.text, /Create README\.md in the project root/);
});

test("folder trust prompt is an unnumbered list", () => {
  const p = parse("trust").prompt;
  assert.equal(p.kind, "trust");
  assert.equal(p.numbered, false);
  assert.deepEqual(
    p.options.map((o: { label: string }) => o.label),
    ["No, exit", "Yes, I trust this folder"],
  );
  assert.equal(p.options[0].cursor, true);
});

test("single AskUserQuestion", () => {
  const p = parse("ask-user-question-single").prompt;
  assert.equal(p.kind, "question");
  assert.equal(p.title, "Color");
  assert.equal(p.question, "Which color do you prefer?");
  assert.equal(p.options.length, 5);
  assert.equal(p.options[0].description, "You prefer red.");
  assert.equal(p.multiSelect, false);
});

test("multi-question AskUserQuestion with checkboxes and tabs", () => {
  const p = parse("ask-user-question-multi").prompt;
  assert.equal(p.kind, "question");
  assert.equal(p.multiSelect, true);
  assert.deepEqual(
    p.tabs.map((t: { label: string }) => t.label),
    ["Fruits", "Size", "Submit"],
  );
  assert.equal(p.options[0].label, "Apple");
  assert.equal(p.options[0].checked, false);
});

test("AskUserQuestion review screen", () => {
  const p = parse("ask-user-question-review").prompt;
  assert.equal(p.kind, "question");
  assert.equal(p.review, true);
  assert.deepEqual(p.answers, [
    { question: "Which fruits?", answer: "Apple" },
    { question: "Which size?", answer: "Large" },
  ]);
  assert.equal(p.options[0].label, "Submit answers");
});

test("/model renders as a generic picker with its current choice", () => {
  const p = parse("model-picker").prompt;
  assert.equal(p.kind, "generic");
  assert.equal(p.title, "Select model");
  assert.equal(p.options.length, 6);
  assert.equal(p.options[2].label, "Fable");
  assert.match(p.options[2].description, /^Fable 5\.1/);
  assert.equal(p.options[5].current, true);
  assert.equal(p.options[5].cursor, true);
});

test("/config is unmodeled", () => {
  const s = parse("unmodeled-config");
  assert.equal(s.prompt, null);
  assert.equal(s.unmodeled, true);
});

test("the signature ignores cursor movement and checkbox state", () => {
  const a = parse("ask-user-question-multi").prompt;
  const moved = fixture("ask-user-question-multi").replace("❯ 1. [ ] Apple", "  1. [✔] Apple").replace("  2. [ ] Banana", "❯ 2. [ ] Banana");
  const b = parseScreen(moved).prompt;
  assert.equal(promptSignature(a), promptSignature(b));
});

test("a narrower terminal wraps the permission prompt and still parses", () => {
  const narrow = fixture("permission-bash").replace(
    "   2. Yes, and always allow access to",
    "   2. Yes, and always allow\n      access to",
  );
  const p = parseScreen(narrow).prompt;
  assert.equal(p.kind, "permission");
  assert.equal(p.options.length, 4);
  assert.match(p.options[1].label, /^Yes, and always allow access to/);
});

test("the strip tail has the requested number of lines", () => {
  const s = parseScreen(fixture("unmodeled-config"), { stripLines: 5 });
  assert.equal(s.tail.split("\n").length, 5);
});

test("a plan prompt whose question wrapped at 80 columns is still a plan", () => {
  const wrapped = fixture("plan-approval")
    .replace(/[─]{20,}/g, "─".repeat(80))
    .replace(
      " Claude has written up a plan and is ready to execute. Would you like to proceed?",
      " Claude has written up a plan and is ready to execute. Would you like to\n proceed?",
    );
  const p = parseScreen(wrapped).prompt;
  assert.equal(p.kind, "plan");
  assert.equal(p.question, "Claude has written up a plan and is ready to execute. Would you like to proceed?");
  assert.ok(p.plan);
});

test("a wrapped path in the trust prompt body is rejoined", () => {
  const wrapped = fixture("trust").replace("scratchp\nad/cvprobe", "scratchp\nad/cvprobe");
  const p = parseScreen(wrapped).prompt;
  assert.equal(p.kind, "trust");
});

test("an input box whose top rule carries the session name is idle, not unmodeled", () => {
  const s = parse("idle-named-session");
  assert.ok(s.input);
  assert.equal(s.unmodeled, false);
  assert.equal(s.activity.state, "idle");
  assert.equal(s.mode.id, "manual");
});

test("/config on the bundled daemon is unmodeled too", () => {
  const s = parse("unmodeled-config-daemon");
  assert.equal(s.prompt, null);
  assert.equal(s.unmodeled, true);
});

test("a scrolled /model list keeps the row carrying the scroll marker", () => {
  const p = parse("model-picker-scrolled").prompt;
  assert.equal(p.kind, "generic");
  assert.deepEqual(
    p.options.map((o: { n: number }) => o.n),
    [2, 3, 4, 5, 6],
  );
  assert.equal(p.options[0].label, "Opus (1M context)");
  assert.match(p.options[0].description, /Best for everyday, complex tasks$/);
  assert.equal(p.options[1].label, "Fable");
  assert.match(p.options[1].description, /hardest and longest-running tasks$/);
  assert.equal(p.options[4].current, true);
  assert.equal(p.options[4].cursor, true);
  assert.ok(!p.body.some((l: string) => l.includes("Opus (1M context)")));
});

test("the /model footer offers s for this session only", () => {
  const p = parse("model-picker-scrolled").prompt;
  assert.deepEqual(p.letterKeys, [{ key: "s", label: "use this session only" }]);
});

test("footers without letter keys offer none", () => {
  assert.deepEqual(parse("permission-bash").prompt.letterKeys, []);
  assert.deepEqual(parseLetterKeys("Enter to select · Tab/Arrow keys to navigate · Esc to cancel"), []);
});
