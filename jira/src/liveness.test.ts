// An agent that exited inside a window that stayed open.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createShellWatch, isShellCommand } from "../liveness.mjs";

test("a login shell, a path, or an exe name is still a shell; an agent is not", () => {
  for (const cmd of ["zsh", "-zsh", "/bin/bash", "fish", "pwsh.exe"]) assert.equal(isShellCommand(cmd), true, cmd);
  for (const cmd of ["claude", "node", "codex", "", "vim"]) assert.equal(isShellCommand(cmd), false, cmd);
});

test("only a shell that stays a shell for the whole grace period counts", () => {
  const watch = createShellWatch(30_000);
  assert.equal(watch.observe("w1", "zsh", 0), false);
  assert.equal(watch.observe("w1", "zsh", 29_999), false);
  assert.equal(watch.observe("w1", "claude", 30_000), false, "the agent came back");
  assert.equal(watch.observe("w1", "zsh", 31_000), false, "the clock starts again");
  assert.equal(watch.observe("w1", "zsh", 61_000), true);
  watch.forget("w1");
  assert.equal(watch.observe("w1", "zsh", 61_001), false);
});
