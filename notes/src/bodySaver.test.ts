import assert from "node:assert/strict";
import { it } from "node:test";
import { BodySaver } from "./bodySaver.ts";

// A save that waits until the test lets it finish, like a slow server.
function slowServer() {
  const pending: { body: string; done: () => void; fail: (e: Error) => void }[] = [];
  const stored: string[] = [];
  const save = (body: string) =>
    new Promise<void>((resolve, reject) => {
      pending.push({
        body,
        done: () => {
          stored.push(body);
          resolve();
        },
        fail: reject,
      });
    });
  return { save, pending, stored };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

it("keeps typing made during a slow save dirty, and saves it next", async () => {
  const server = slowServer();
  const saver = new BodySaver(server.save, "");
  saver.edit("abc");
  const first = saver.flush();
  await tick();
  assert.equal(server.pending.length, 1);
  // Typed while the save above is still on its way.
  saver.edit("abcdef");
  server.pending[0].done();
  await first;
  assert.equal(saver.dirty, true, "the newer text isn't saved yet");
  // The poll echoes the older saved text back: it must not replace the typing.
  assert.equal(saver.external("abc"), false);
  assert.equal(saver.text, "abcdef");
  const second = saver.flush();
  await tick();
  server.pending[1].done();
  await second;
  assert.equal(saver.dirty, false);
  assert.deepEqual(server.stored, ["abc", "abcdef"]);
});

it("runs saves one at a time, in order", async () => {
  const server = slowServer();
  const saver = new BodySaver(server.save, "");
  saver.edit("one");
  const a = saver.flush();
  saver.edit("two");
  const b = saver.flush();
  await tick();
  assert.equal(server.pending.length, 1, "the second save waits for the first");
  server.pending[0].done();
  await a;
  await tick();
  assert.equal(server.pending.length, 2);
  server.pending[1].done();
  await b;
  assert.deepEqual(server.stored, ["one", "two"]);
  assert.equal(saver.dirty, false);
});

it("stays dirty after a failed save and retries on the next flush", async () => {
  const server = slowServer();
  const saver = new BodySaver(server.save, "x");
  saver.edit("y");
  const a = saver.flush();
  await tick();
  server.pending[0].fail(new Error("offline"));
  await assert.rejects(a, /offline/);
  assert.equal(saver.dirty, true);
  const b = saver.flush();
  await tick();
  server.pending[1].done();
  await b;
  assert.equal(saver.dirty, false);
});

it("takes another device's edit only when nothing is unsaved", async () => {
  const saver = new BodySaver(async () => {}, "a");
  assert.equal(saver.external("from phone"), true);
  assert.equal(saver.text, "from phone");
  saver.edit("local");
  assert.equal(saver.external("from tablet"), false);
  assert.equal(saver.text, "local");
});

it("skips a save when the text is already saved", async () => {
  let calls = 0;
  const saver = new BodySaver(async () => void calls++, "same");
  await saver.flush();
  assert.equal(calls, 0);
});
