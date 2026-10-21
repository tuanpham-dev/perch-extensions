import assert from "node:assert/strict";
import os from "node:os";
import { describe, it } from "node:test";
import { buildPrompt, describeOs, describeShell } from "../server.js";

describe("the generate prompt", () => {
  it("names the server's real OS and release", () => {
    assert.equal(describeOs("linux", "6.12.1"), "Linux 6.12.1");
    assert.equal(describeOs("darwin", "24.1.0"), "macOS (Darwin 24.1.0)");
    assert.equal(describeOs("win32", "10.0.22631"), "Windows 10.0.22631");
    // Defaults come from this process's os module, not a hard-coded name.
    assert.ok(describeOs().endsWith(os.release()));
  });

  it("names the shell, or a POSIX shell when SHELL is unset", () => {
    assert.equal(describeShell("/usr/bin/zsh"), "the zsh shell");
    if (os.platform() !== "win32") assert.equal(describeShell(""), "a POSIX shell");
  });

  it("puts both, the directory and the request into the prompt", () => {
    const prompt = buildPrompt("  list files ", "/repo", "macOS (Darwin 24.1.0)", "the zsh shell");
    assert.match(prompt, /for the zsh shell on macOS \(Darwin 24\.1\.0\)\./);
    assert.match(prompt, /Current directory: \/repo\n/);
    assert.match(prompt, /Request: list files$/);
    assert.doesNotMatch(buildPrompt("x", ""), /Current directory/);
  });
});
