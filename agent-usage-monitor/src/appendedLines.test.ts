import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { readAppendedLines } from "../appendedLines.mjs";
import { parseUsageLines } from "../usageModel.mjs";

function tempFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "appended-"));
  return { file: path.join(dir, "t.jsonl"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

async function readFrom(file: string, from: number, chunkBytes?: number) {
  const texts: string[] = [];
  const offset = await readAppendedLines(file, from, statSync(file).size, (t: string) => texts.push(t), chunkBytes);
  return { offset, text: texts.join("") };
}

describe("readAppendedLines", () => {
  it("reads only what was appended, and leaves a half-written line for later", async () => {
    const { file, done } = tempFile();
    try {
      writeFileSync(file, "one\ntwo\nthr");
      const first = await readFrom(file, 0);
      assert.equal(first.text, "one\ntwo\n");
      assert.equal(first.offset, 8);
      appendFileSync(file, "ee\nfour\n");
      const second = await readFrom(file, first.offset);
      assert.equal(second.text, "three\nfour\n");
      assert.equal(second.offset, statSync(file).size);
      const third = await readFrom(file, second.offset);
      assert.deepEqual(third, { offset: second.offset, text: "" }, "nothing new: nothing read");
    } finally {
      done();
    }
  });

  it("keeps lines and multi-byte characters whole across small chunks", async () => {
    const { file, done } = tempFile();
    try {
      const lines = ["a…b", "x".repeat(50), "ünïcode ✓", ""].join("\n");
      writeFileSync(file, lines);
      const { text, offset } = await readFrom(file, 0, 7);
      assert.equal(text, lines);
      assert.equal(offset, Buffer.byteLength(lines));
    } finally {
      done();
    }
  });

  it("is null for a file that can't be read", async () => {
    assert.equal(await readAppendedLines("/nonexistent/t.jsonl", 0, 10, () => {}), null);
  });
});

describe("parseUsageLines across appended reads", () => {
  it("dedupes a retried message even when it lands in a later read", () => {
    const line = JSON.stringify({
      type: "assistant",
      requestId: "req_1",
      timestamp: "2026-10-27T12:00:00.000Z",
      message: { id: "msg_1", model: "m", usage: { input_tokens: 1, output_tokens: 2 } },
    });
    const seen = new Set();
    assert.equal(parseUsageLines(line + "\n", seen).length, 1);
    assert.equal(parseUsageLines(line + "\n", seen).length, 0);
    assert.equal(parseUsageLines(line + "\n").length, 1, "a fresh call starts a fresh dedupe");
  });
});
