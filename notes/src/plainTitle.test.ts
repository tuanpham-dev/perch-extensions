import assert from "node:assert/strict";
import { it } from "node:test";
import { plainTitle } from "./plainTitle.ts";

it("turns a note's first line into plain text", () => {
  assert.equal(plainTitle("See [the grid PR](https://x/pr/12) and **docs**."), "See the grid PR and docs.");
  assert.equal(plainTitle("\n## Release *checklist*\n- tag"), "Release checklist");
  assert.equal(plainTitle("- [ ] run `npm test`"), "run npm test");
  assert.equal(plainTitle("   "), "Empty note");
  assert.equal(plainTitle("x".repeat(80), 10), "xxxxxxxxx…");
});
