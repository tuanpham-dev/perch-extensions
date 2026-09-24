// Finding skills, and what happens when one cannot be read or has moved.
// The cases that matter are the awkward ones: frontmatter nobody can parse, a
// name that exists twice, and a stored choice that is no longer there.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverSkills, parseFrontmatter, parseSkillPaths, resolveSlot } from "../skills.mjs";

async function tree() {
  const root = await mkdtemp(path.join(tmpdir(), "skills-"));
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  await mkdir(path.join(repo, ".claude", "skills"), { recursive: true });
  return { root, home, repo };
}

async function skill(dir: string, name: string, body = "") {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), body || `---\nname: ${name}\ndescription: What ${name} does.\n---\n\n# ${name}\n`);
  return dir;
}

// ---- frontmatter ----

test("a plain name and description are read", () => {
  assert.deepEqual(parseFrontmatter("---\nname: a\ndescription: B c.\n---\nbody"), { name: "a", description: "B c." });
});

test("quotes around a value are stripped, and a colon inside it survives", () => {
  const front = parseFrontmatter(`---\nname: 'a'\ndescription: "Use when: you must."\n---`);
  assert.equal(front.name, "a");
  assert.equal(front.description, "Use when: you must.");
});

test("no frontmatter at all is not an error", () => {
  assert.deepEqual(parseFrontmatter("# Just a heading\n"), {});
  assert.deepEqual(parseFrontmatter(""), {});
});

test("a line that is not a scalar pair is skipped rather than guessed at", () => {
  const front = parseFrontmatter("---\nname: a\ntools:\n  - one\n  - two\ndescription: d\n---");
  assert.equal(front.name, "a");
  assert.equal(front.description, "d");
  assert.equal(front.tools, "");
});

// ---- discovery ----

test("skills are found in the user's directory and the repository's", async () => {
  const { home, repo } = await tree();
  await skill(path.join(home, ".claude", "skills", "shopify-qa"), "shopify-qa");
  await skill(path.join(repo, ".claude", "skills", "house-style"), "house-style");
  const found = await discoverSkills({ home, repo });
  assert.deepEqual(
    found.map((s) => [s.name, s.origin]).sort(),
    [["house-style", "this repo"], ["shopify-qa", "yours"]],
  );
  assert.equal(found[0].description.startsWith("What "), true);
});

test("a directory with no SKILL.md is not a skill", async () => {
  const { home } = await tree();
  await mkdir(path.join(home, ".claude", "skills", "notes"), { recursive: true });
  assert.deepEqual(await discoverSkills({ home }), []);
});

test("a skill whose frontmatter cannot be read is listed under its folder name, not hidden", async () => {
  const { home } = await tree();
  await skill(path.join(home, ".claude", "skills", "odd-one"), "", "no frontmatter here\n");
  const found = await discoverSkills({ home });
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "odd-one");
  assert.equal(found[0].description, "");
});

test("the same name in two places is two skills, told apart by where they came from", async () => {
  const { home, repo } = await tree();
  await skill(path.join(home, ".claude", "skills", "shopify-qa"), "shopify-qa");
  await skill(path.join(repo, ".claude", "skills", "shopify-qa"), "shopify-qa");
  const found = await discoverSkills({ home, repo });
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((s) => s.origin), ["yours", "this repo"]);
  assert.notEqual(found[0].dir, found[1].dir);
});

test("an added path may be one skill or a directory of them", async () => {
  const { root, home } = await tree();
  const single = await skill(path.join(root, "elsewhere", "lone-skill"), "lone-skill");
  await skill(path.join(root, "bundle", "first"), "first");
  await skill(path.join(root, "bundle", "second"), "second");
  const found = await discoverSkills({ home, extraPaths: [single, path.join(root, "bundle")] });
  assert.deepEqual(found.map((s) => s.name).sort(), ["first", "lone-skill", "second"]);
  assert.equal(found.every((s) => s.origin === "added"), true);
});

test("a symlinked skill directory is found - the trap that hides symlinked extensions", async () => {
  const { root, home } = await tree();
  const real = await skill(path.join(root, "real", "linked-skill"), "linked-skill");
  await symlink(real, path.join(home, ".claude", "skills", "linked-skill"));
  const found = await discoverSkills({ home });
  assert.deepEqual(found.map((s) => s.name), ["linked-skill"]);
});

test("the same directory reached twice is listed once", async () => {
  const { home } = await tree();
  const dir = await skill(path.join(home, ".claude", "skills", "twice"), "twice");
  const found = await discoverSkills({ home, extraPaths: [dir] });
  assert.equal(found.length, 1);
  assert.equal(found[0].origin, "yours");
});

test("a missing home or repository directory is not an error", async () => {
  assert.deepEqual(await discoverSkills({ home: "/nonexistent", repo: "/also-nonexistent" }), []);
});

// ---- choosing ----

test("an empty setting takes the named default when it is installed", async () => {
  const { home } = await tree();
  await skill(path.join(home, ".claude", "skills", "execute-jira-ticket"), "execute-jira-ticket");
  const found = await discoverSkills({ home });
  const chosen = resolveSlot("", found, "execute-jira-ticket");
  assert.equal(chosen.skill?.name, "execute-jira-ticket");
  assert.equal(chosen.missing, false);
});

test("an empty setting with no default installed leaves the slot empty, not missing", async () => {
  const chosen = resolveSlot("", [], "execute-jira-ticket");
  assert.deepEqual(chosen, { skill: null, missing: false, explicitNone: false });
});

test("\"none\" is a choice, and reads differently from nothing being installed", () => {
  const chosen = resolveSlot("none", [], "execute-jira-ticket");
  assert.equal(chosen.skill, null);
  assert.equal(chosen.explicitNone, true);
});

test("a stored directory wins over a bare name, so two skills sharing a name stay distinct", async () => {
  const { home, repo } = await tree();
  await skill(path.join(home, ".claude", "skills", "shopify-qa"), "shopify-qa");
  const theirs = await skill(path.join(repo, ".claude", "skills", "shopify-qa"), "shopify-qa");
  const found = await discoverSkills({ home, repo });
  assert.equal(resolveSlot(theirs, found, null).skill?.origin, "this repo");
  assert.equal(resolveSlot("shopify-qa", found, null).skill?.origin, "yours");
});

test("a stored choice that has gone comes back as missing rather than quietly becoming the default", async () => {
  const { home } = await tree();
  await skill(path.join(home, ".claude", "skills", "execute-jira-ticket"), "execute-jira-ticket");
  const found = await discoverSkills({ home });
  const chosen = resolveSlot("/gone/skill", found, "execute-jira-ticket");
  assert.equal(chosen.skill, null);
  assert.equal(chosen.missing, true);
  assert.equal(chosen.wanted, "/gone/skill");
});

test("skill paths are split on newlines and commas, blanks dropped", () => {
  assert.deepEqual(parseSkillPaths(" /a \n\n/b,/c \n"), ["/a", "/b", "/c"]);
  assert.deepEqual(parseSkillPaths(""), []);
  assert.deepEqual(parseSkillPaths(undefined), []);
});
