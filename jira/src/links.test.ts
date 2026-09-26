// The links a review is built on. The three shapes are the ones real tickets
// carry, copied from their comments.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findTicketLinks } from "../links.mjs";

const detail = {
  created: "2026-09-01T10:00:00.000Z",
  description: "Spec: see https://github.com/barrel/carepod-theme/pull/140.",
  comments: [
    { author: "Gary", created: "2026-09-10T10:00:00.000Z", body: "PR: https://github.com/barrel/carepod-theme/pull/149" },
    {
      author: "Felipe",
      created: "2026-09-11T10:00:00.000Z",
      body: "Editor: https://admin.shopify.com/store/hellocarepodau/themes/158790975719/editor?previewPath=%2Fproducts%2Fpod",
    },
    {
      author: "Gary",
      created: "2026-09-12T10:00:00.000Z",
      body: "Updated https://github.com/barrel/carepod-theme/pull/163 and https://hellocarepod.com/?_ab=0&_fd=0&_sc=1&preview_theme_id=157667524839",
    },
    { author: "Olga", created: "2026-09-13T10:00:00.000Z", body: "Screens: https://i.imgur.com/53SyMqb.png" },
    {
      author: "Felipe",
      created: "2026-09-14T10:00:00.000Z",
      body: "Again: [preview](https://hellocarepod.com/collections/all?preview_theme_id=158790975719&_ab=0)",
    },
  ],
};

test("pull requests are parsed and ordered newest first, description last", () => {
  const { prs } = findTicketLinks(detail);
  assert.deepEqual(
    prs.map((pr) => [pr.number, pr.owner, pr.repo, pr.author]),
    [
      [163, "barrel", "carepod-theme", "Gary"],
      [149, "barrel", "carepod-theme", "Gary"],
      [140, "barrel", "carepod-theme", null],
    ],
  );
  assert.equal(prs[2].url, "https://github.com/barrel/carepod-theme/pull/140", "trailing period dropped");
});

test("preview and editor links carry their theme, origin and path", () => {
  const { previews } = findTicketLinks(detail);
  assert.deepEqual(
    previews.map((p) => [p.kind, p.themeId, p.origin, p.path, p.store]),
    [
      ["preview", "158790975719", "https://hellocarepod.com", "/collections/all", ""],
      ["preview", "157667524839", "https://hellocarepod.com", "/", ""],
      ["editor", "158790975719", "", "/products/pod", "hellocarepodau"],
    ],
  );
});

test("unrelated links and a ticket with no comments find nothing", () => {
  assert.deepEqual(findTicketLinks({ description: "https://example.com/a", comments: [] }), { prs: [], previews: [] });
  assert.deepEqual(findTicketLinks({}), { prs: [], previews: [] });
});

test("the same link twice is listed once, at its newest mention", () => {
  const { prs } = findTicketLinks({
    comments: [
      { author: "A", created: "2026-01-01", body: "https://github.com/o/r/pull/1" },
      { author: "B", created: "2026-02-01", body: "https://github.com/o/r/pull/1/files" },
    ],
  });
  assert.equal(prs.length, 1);
  assert.equal(prs[0].author, "B");
});
