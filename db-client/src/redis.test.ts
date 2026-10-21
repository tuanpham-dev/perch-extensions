import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capReply, isBlockingCommand } from "../server/engines/redis.mjs";

describe("Redis console", () => {
  it("sends blocking commands to a client of their own", () => {
    for (const line of [["BLPOP", "q", "0"], ["brpop", "q", "0"], ["BLMOVE", "a", "b", "LEFT", "RIGHT", "0"], ["SUBSCRIBE", "news"], ["psubscribe", "n*"], ["MONITOR"], ["WAIT", "1", "0"]]) {
      assert.equal(isBlockingCommand(line), true, line.join(" "));
    }
    assert.equal(isBlockingCommand(["XREAD", "BLOCK", "0", "STREAMS", "s", "$"]), true);
    assert.equal(isBlockingCommand(["xreadgroup", "GROUP", "g", "c", "block", "100", "STREAMS", "s", ">"]), true);
    assert.equal(isBlockingCommand(["XREAD", "COUNT", "5", "STREAMS", "s", "0"]), false);
    assert.equal(isBlockingCommand(["GET", "BLOCK"]), false);
    assert.equal(isBlockingCommand(["LPOP", "q"]), false);
  });

  it("caps a long reply at the row limit", () => {
    const list = Array.from({ length: 12 }, (_, i) => String(i));
    assert.deepEqual(capReply(list, 5), { reply: list.slice(0, 5), truncated: true, rowCount: 12 });
    assert.deepEqual(capReply(list, 12), { reply: list, truncated: false });
    const hash = Object.fromEntries(list.map((k) => [k, k]));
    const capped = capReply(hash, 3);
    assert.equal(Object.keys(capped.reply as object).length, 3);
    assert.equal(capped.truncated, true);
    const map = new Map(list.map((k) => [k, k]));
    assert.equal((capReply(map, 4).reply as Map<string, string>).size, 4);
    assert.deepEqual(capReply("OK", 1), { reply: "OK", truncated: false });
    assert.deepEqual(capReply(null, 1), { reply: null, truncated: false });
  });
});
