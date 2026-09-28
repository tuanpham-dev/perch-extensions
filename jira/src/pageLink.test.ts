import assert from "node:assert/strict";
import { test } from "node:test";
import { pagePath, portPageUrl, previewPageUrl } from "./pageLink.ts";

const local = { protocol: "http:", hostname: "localhost", origin: "http://localhost:8044" };
const remote = { protocol: "https:", hostname: "perch.example.com", origin: "https://perch.example.com" };

test("a page is a path on the dev server", () => {
  assert.equal(pagePath(""), "/");
  assert.equal(pagePath("pages/about"), "/pages/about");
  assert.equal(pagePath("/products/socks?variant=2#reviews"), "/products/socks?variant=2#reviews");
  assert.equal(pagePath("https://shop.test/cart?x=1"), "/cart?x=1", "a full URL keeps only its path");
});

test("on the machine itself the port is opened directly", () => {
  assert.equal(portPageUrl(9292, "/collections/all", local, null), "http://localhost:9292/collections/all");
  assert.equal(portPageUrl(9292, "", { ...local, hostname: "127.0.0.1" }, "dev.test"), "http://127.0.0.1:9292/", "even with a proxy domain");
});

test("from elsewhere it goes through Perch's port proxy", () => {
  assert.equal(portPageUrl(9292, "/pages/about", remote, "dev.example.com"), "https://9292.dev.example.com/pages/about");
  assert.equal(portPageUrl(9292, "/pages/about", remote, null), "https://perch.example.com/proxy/9292/pages/about");
});

test("the QA agent's preview URL opens on the ticket's page", () => {
  assert.equal(previewPageUrl("http://127.0.0.1:9292/?preview_theme_id=5", "/products/socks"), "http://127.0.0.1:9292/products/socks?preview_theme_id=5");
  assert.equal(previewPageUrl("http://127.0.0.1:9292", ""), "http://127.0.0.1:9292/");
  assert.equal(previewPageUrl("not a url", "/x"), "");
});
