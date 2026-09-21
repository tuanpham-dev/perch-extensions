import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMessages, createChatModel } from "./chatModel.ts";

const userMessage = (text: string) => ({ type: "user" as const, uuid: "u1", message: { role: "user", content: text } });

test("a pasted_content block shows as the text the person wrote", () => {
  const model = createChatModel();
  applyMessages(model, [userMessage('\n\n<pasted_content id="4a5c">\nadd filters to the ticket list\n</pasted_content id="4a5c">\n')]);
  assert.deepEqual(
    model.items.map((i) => (i.kind === "text" ? i.text : i.kind)),
    ["add filters to the ticket list"],
  );
});

test("text around a pasted_content block is kept", () => {
  const model = createChatModel();
  applyMessages(model, [userMessage('look at this:\n\n<pasted_content id="00ff">\nstack trace\n</pasted_content id="00ff">\n\nwhat broke?')]);
  const item = model.items[0];
  assert.equal(item?.kind, "text");
  assert.equal(item.kind === "text" ? item.text : "", "look at this:\n\nstack trace\n\nwhat broke?");
});
