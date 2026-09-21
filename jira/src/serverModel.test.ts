// The pure parts of server.js: the JQL a filter composes into, the porcelain
// `git worktree list` parse, the path convention that lets a worktree be
// matched to its session, and the ADF-to-Markdown rendering behind every
// ticket body the panel shows and the agent is handed.
//
// server.js holds the credential and the routes, so it is not tested as a
// whole - but these decide what gets queried, which worktrees are offered,
// whether a session is found at all, and what a ticket says, and each is
// wrong in a way no type check would catch. Imported the way agent-tasks' model.test.ts
// imports ../model.mjs.
import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { adfToMarkdown, composeJql, openClause, parseWorktreeList, readSortParams, shortenHome } from "../server.js";

interface Filters {
  status: string[];
  assignee: string[];
  type: string[];
  priority: string[];
  text: string;
}

const NONE: Filters = { status: [], assignee: [], type: [], priority: [], text: "" };
const filters = (patch: Partial<Filters> = {}): Filters => ({ ...NONE, ...patch });

const MINE = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

// ---- composeJql ----

test("no filters leaves the query byte-identical", () => {
  assert.equal(composeJql(MINE, filters()), MINE);
});

test("a ticked status is AND-ed on, ahead of the ORDER BY", () => {
  assert.equal(
    composeJql(MINE, filters({ status: ["In Review"] })),
    '(assignee = currentUser() AND statusCategory != Done) AND status in ("In Review") ORDER BY updated DESC',
  );
});

test("several values in one facet are one in-clause, not one clause each", () => {
  const jql = composeJql('project = "CAP"', filters({ status: ["In Review", "Blocked"] }));
  assert.equal(jql, '(project = "CAP") AND status in ("In Review", "Blocked")');
});

test("the base query is parenthesised, so a bare OR cannot swallow the filter", () => {
  // Without the parens this would read `a = 1 OR (b = 2 AND issuetype ...)`,
  // which widens the result instead of narrowing it.
  assert.equal(
    composeJql("a = 1 OR b = 2 ORDER BY key", filters({ type: ["Bug"] })),
    '(a = 1 OR b = 2) AND issuetype in ("Bug") ORDER BY key',
  );
});

test("a query with no ORDER BY gains no trailing space", () => {
  const jql = composeJql('project = "CAP"', filters({ type: ["Bug"] }));
  assert.equal(jql, jql.trim());
});

test("ORDER BY is found at the end even when a value contains those words", () => {
  const jql = composeJql('summary ~ "order by date" ORDER BY created', filters({ type: ["Bug"] }));
  assert.ok(jql.endsWith("ORDER BY created"));
  assert.ok(jql.includes('(summary ~ "order by date")'));
});

test("unassigned is a clause of its own, not an accountId", () => {
  assert.equal(
    composeJql('project = "CAP"', filters({ assignee: ["unassigned"] })),
    '(project = "CAP") AND assignee is EMPTY',
  );
});

test("unassigned ticked alongside a person matches either", () => {
  assert.equal(
    composeJql('project = "CAP"', filters({ assignee: ["unassigned", "557058:ab"] })),
    '(project = "CAP") AND (assignee in ("557058:ab") OR assignee is EMPTY)',
  );
});

test("a key-shaped search finds the ticket its summary would not", () => {
  const jql = composeJql('project = "CAP"', filters({ text: "cap-12" }));
  assert.ok(jql.includes("key = CAP-12"));
  assert.ok(jql.includes('summary ~ "cap-12"'));
});

test("ordinary search text matches the summary only", () => {
  assert.equal(composeJql('project = "CAP"', filters({ text: "header" })), '(project = "CAP") AND summary ~ "header"');
});

test("a quote in a facet value cannot end the JQL string it sits in", () => {
  const jql = composeJql('project = "CAP"', filters({ status: ['Waiting "on" them'] }));
  assert.ok(jql.includes('status in ("Waiting \\"on\\" them")'));
});

test("a backslash in a facet value is escaped before the quotes are", () => {
  const jql = composeJql('project = "CAP"', filters({ status: ["back\\slash"] }));
  assert.ok(jql.includes('"back\\\\slash"'));
});

test("every facet can apply at once", () => {
  const jql = composeJql(
    MINE,
    filters({ status: ["In Review"], assignee: ["557058:ab"], type: ["Bug"], priority: ["High"], text: "nav" }),
  );
  for (const part of ["status in", "assignee in", "issuetype in", "priority in", "summary ~"]) {
    assert.ok(jql.includes(part), `missing ${part}`);
  }
  assert.ok(jql.endsWith("ORDER BY updated DESC"));
});

// ---- parseWorktreeList ----

const PORCELAIN = [
  "worktree /works/acme",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /works/acme/.worktrees/CAP-1",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/feature/CAP-1",
  "",
  "worktree /works/acme/.worktrees/spike",
  "HEAD 3333333333333333333333333333333333333333",
  "detached",
  "",
].join("\n");

test("every checkout is listed, main first", () => {
  const rows = parseWorktreeList(PORCELAIN);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].path, "/works/acme");
});

test("a branch is reported without its refs/heads prefix", () => {
  const rows = parseWorktreeList(PORCELAIN);
  assert.equal(rows[0].branch, "main");
  assert.equal(rows[1].branch, "feature/CAP-1");
});

test("a detached checkout has no branch but keeps its head", () => {
  const detached = parseWorktreeList(PORCELAIN)[2];
  assert.equal(detached.branch, null);
  assert.equal(detached.detached, true);
  assert.ok(detached.head?.startsWith("3333333"));
});

test("empty output is no worktrees rather than a broken row", () => {
  assert.deepEqual(parseWorktreeList(""), []);
});

// ---- shortenHome ----

test("a path under home is reported the way core reports a session's", () => {
  assert.equal(shortenHome(`${os.homedir()}/works/acme`), "~/works/acme");
  assert.equal(shortenHome(os.homedir()), "~");
});

test("a path outside home is left alone", () => {
  assert.equal(shortenHome("/works/acme"), "/works/acme");
});

test("a sibling directory that merely starts like home is not shortened", () => {
  // `${home}-backup` shares a prefix with home but is not inside it; matching
  // on the prefix alone would mangle it into "~-backup".
  assert.equal(shortenHome(`${os.homedir()}-backup/acme`), `${os.homedir()}-backup/acme`);
});

// ---- adfToMarkdown ----

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, ...marks: unknown[]) => (marks.length ? { type: "text", text, marks } : { type: "text", text });

test("paragraphs are separated by a blank line", () => {
  assert.equal(adfToMarkdown(doc(p(t("one")), p(t("two")))), "one\n\ntwo");
});

test("bold, italic, strike and code keep their meaning", () => {
  const md = adfToMarkdown(
    doc(p(t("b", { type: "strong" }), t(" "), t("i", { type: "em" }), t(" "), t("s", { type: "strike" }), t(" "), t("c", { type: "code" }))),
  );
  assert.equal(md, "**b** *i* ~~s~~ `c`");
});

test("emphasis whitespace sits outside the markers, or it would not render", () => {
  assert.equal(adfToMarkdown(doc(p(t("bold ", { type: "strong" }), t("next")))), "**bold** next");
});

test("a link keeps both its label and its target", () => {
  const md = adfToMarkdown(doc(p(t("Preview", { type: "link", attrs: { href: "https://x.test/p" } }))));
  assert.equal(md, "[Preview](https://x.test/p)");
});

test("a bare smart link becomes an autolink", () => {
  assert.equal(adfToMarkdown(doc(p({ type: "inlineCard", attrs: { url: "https://x.test/a" } }))), "<https://x.test/a>");
});

test("markup characters in plain text are escaped, underscores are not", () => {
  assert.equal(adfToMarkdown(doc(p(t("a*b [x] snake_case")))), "a\\*b \\[x\\] snake_case");
});

test("headings keep their level", () => {
  assert.equal(adfToMarkdown(doc({ type: "heading", attrs: { level: 3 }, content: [t("Steps")] })), "### Steps");
});

test("nested lists indent under their parent item", () => {
  const md = adfToMarkdown(
    doc({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            p(t("parent")),
            { type: "orderedList", content: [{ type: "listItem", content: [p(t("child"))] }] },
          ],
        },
      ],
    }),
  );
  assert.equal(md, "- parent\n  1. child");
});

test("an ordered list honours its start number", () => {
  const md = adfToMarkdown(
    doc({ type: "orderedList", attrs: { order: 3 }, content: [{ type: "listItem", content: [p(t("c"))] }] }),
  );
  assert.equal(md, "3. c");
});

test("a code block is fenced with its language and left unescaped", () => {
  const md = adfToMarkdown(doc({ type: "codeBlock", attrs: { language: "ts" }, content: [t("const a = b * c;")] }));
  assert.equal(md, "```ts\nconst a = b * c;\n```");
});

test("a code block holding a fence gets a longer fence", () => {
  const md = adfToMarkdown(doc({ type: "codeBlock", content: [t("```\ninner\n```")] }));
  assert.ok(md.startsWith("````\n"));
  assert.ok(md.endsWith("\n````"));
});

test("a table becomes a GFM table with a header row", () => {
  const cell = (type: string, text: string) => ({ type, content: [p(t(text))] });
  const md = adfToMarkdown(
    doc({
      type: "table",
      content: [
        { type: "tableRow", content: [cell("tableHeader", "Name"), cell("tableHeader", "Value")] },
        { type: "tableRow", content: [cell("tableCell", "a|b"), cell("tableCell", "1")] },
      ],
    }),
  );
  assert.equal(md, "| Name | Value |\n| --- | --- |\n| a\\|b | 1 |");
});

test("a panel reads as a labelled quote", () => {
  const md = adfToMarkdown(doc({ type: "panel", attrs: { panelType: "warning" }, content: [p(t("Careful"))] }));
  assert.equal(md, "> **Warning:** Careful");
});

test("mentions, statuses and task items all survive", () => {
  assert.equal(adfToMarkdown(doc(p({ type: "mention", attrs: { text: "@Dana Okafor" } }))), "@Dana Okafor");
  assert.equal(adfToMarkdown(doc(p({ type: "status", attrs: { text: "blocked" } }))), "`BLOCKED`");
  const tasks = adfToMarkdown(
    doc({
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { state: "DONE" }, content: [t("done")] },
        { type: "taskItem", attrs: { state: "TODO" }, content: [t("todo")] },
      ],
    }),
  );
  assert.equal(tasks, "- [x] done\n- [ ] todo");
});

test("an attachment is named rather than dropped", () => {
  const md = adfToMarkdown(doc({ type: "mediaSingle", content: [{ type: "media", attrs: { alt: "shot.png" } }] }));
  assert.equal(md, "*(attachment: shot.png)*");
});

test("no description is an empty string", () => {
  assert.equal(adfToMarkdown(null), "");
  assert.equal(adfToMarkdown(doc()), "");
});

// ---- Sorting ----

test("a chosen sort replaces the base query's ORDER BY", () => {
  assert.equal(composeJql(MINE, filters(), { field: "key", dir: "asc" }), "assignee = currentUser() AND statusCategory != Done ORDER BY key ASC");
});

test("any field but key gets key as a tiebreaker, so equal rows keep one order", () => {
  assert.ok(composeJql(MINE, filters(), { field: "status", dir: "desc" }).endsWith("ORDER BY status DESC, key ASC"));
});

test("the sort field names map to their JQL fields", () => {
  assert.ok(composeJql('project = "CAP"', filters(), { field: "type", dir: "asc" }).endsWith("ORDER BY issuetype ASC, key ASC"));
});

test("filters and a sort compose together", () => {
  assert.equal(
    composeJql(MINE, filters({ type: ["Bug"] }), { field: "priority", dir: "desc" }),
    '(assignee = currentUser() AND statusCategory != Done) AND issuetype in ("Bug") ORDER BY priority DESC, key ASC',
  );
});

test("a sort also replaces a custom query's own ORDER BY", () => {
  assert.equal(composeJql("project = CAP ORDER BY rank", filters(), { field: "key", dir: "desc" }), "project = CAP ORDER BY key DESC");
});

test("no filters and no sort stays byte-identical", () => {
  assert.equal(composeJql(MINE, filters(), null), MINE);
});

test("only known sort fields and directions are accepted", () => {
  assert.deepEqual(readSortParams({ sort: "key", dir: "ASC" }), { field: "key", dir: "asc" });
  assert.equal(readSortParams({ sort: "key; DROP", dir: "asc" }), null);
  assert.equal(readSortParams({ sort: "constructor", dir: "asc" }), null);
  assert.equal(readSortParams({ sort: "key", dir: "sideways" }), null);
  assert.equal(readSortParams({}), null);
});

// ---- The board's query ----

test("the lists exclude Done exactly as before", () => {
  assert.equal(openClause(false, 14), "statusCategory != Done");
});

test("the board lets recently finished tickets back in", () => {
  assert.equal(openClause(true, 14), "(statusCategory != Done OR statusCategoryChangedDate >= -14d)");
});

test("a done window of 0 keeps Done off the board", () => {
  assert.equal(openClause(true, 0), "statusCategory != Done");
});
