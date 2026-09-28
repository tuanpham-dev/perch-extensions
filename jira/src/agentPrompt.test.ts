// Answering a permission prompt from the board: read it, then press only
// what the prompt still on screen offers.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { answerPrompt, promptOf } from "../agentPrompt.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const screen = fs.readFileSync(path.join(here, "fixtures", "permission-bash.txt"), "utf8");

test("a permission prompt reads as numbered options with a signature", () => {
  const prompt = promptOf(screen);
  assert.ok(prompt);
  assert.equal(prompt.kind, "permission");
  assert.ok(prompt.options.length >= 3);
  assert.equal(prompt.options[0].n, 1);
  assert.ok(prompt.signature);
  assert.equal(promptOf("just a shell prompt $ "), null);
});

test("an option is chosen with its digit, and only while the same prompt shows", async () => {
  const sent: string[] = [];
  const base = { capture: async () => screen, send: async (bytes: string) => void sent.push(bytes), typed: (t: string) => t, sleep: async () => {} };
  const signature = promptOf(screen)!.signature;
  assert.deepEqual(await answerPrompt({ ...base, action: { type: "option", n: 2 }, expect: signature }), { ok: true });
  assert.deepEqual(sent, ["2"]);
  const stale = await answerPrompt({ ...base, action: { type: "option", n: 1 }, expect: "something else" });
  assert.equal(stale.ok, false);
  assert.deepEqual(sent, ["2"], "nothing sent to a prompt that changed");
});

test("only the fallback keys are sent, and a reply is typed and submitted", async () => {
  const sent: [string, boolean][] = [];
  const base = { capture: async () => "no prompt here", send: async (bytes: string, submit: boolean) => void sent.push([bytes, submit]), typed: (t: string) => `typed:${t}`, sleep: async () => {} };
  assert.equal((await answerPrompt({ ...base, action: { type: "key", key: "esc" } })).ok, true);
  assert.equal((await answerPrompt({ ...base, action: { type: "key", key: "ctrlC" } })).ok, false);
  assert.equal((await answerPrompt({ ...base, action: { type: "text", text: "use the other file" } })).ok, true);
  assert.deepEqual(sent, [["\x1b", false], ["typed:use the other file", true]]);
});
