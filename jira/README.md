# Jira

A JIRA sidebar tab listing the issues assigned to you and the active repo's project, with
filters on each list, a "Start work" action that creates a worktree session - for one ticket
or for several at once - and a way to hand more tickets to a worktree that already exists.
Backed by the Jira Cloud REST API v3.

## Requirements

- A Jira Cloud site (`https://your-team.atlassian.net`).
- An API token from [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens).

Set `jira.siteUrl` and `jira.email` in Settings, then paste the token into the **API token**
field in the same section. Until all three are present the panel shows a setup hint rather
than an error.

### Where the token is kept

Not in a setting. Configuration values live in the settings document, which the client GETs,
merges, and PUTs back whole - so anything stored there is readable by anything with access to
the app. The token goes into the host's per-extension secret store instead: stripped from
`GET /api/settings`, restored from disk on every document write, and reachable only by this
extension's own server hook. That is why it has no row in the settings table below, and why
the field only ever tells you whether a token is stored, never what it is.

It survives disabling and re-enabling the extension. Uninstalling clears it.

## Project key

The project section needs to know which Jira project belongs to the repo you are looking at.
Four sources are tried, most local first - the first one that yields something shaped like a
project key wins:

| Order | Source | Example |
|---|---|---|
| 1 | A file in the repo root, named by `jira.projectKeyFile` | `.jira-project` containing `CAP` |
| 2 | A `jira.projectMap` entry for the repo root | `{"/works/acme": "CAP"}` |
| 3 | The environment variable named by `jira.projectKeyEnv` | `JIRA_PROJECT_KEY=CAP` |
| 4 | The flat `jira.projectKey` setting | `CAP` |

The in-repo file wins the way `.editorconfig` and `.nvmrc` beat user-level config. A malformed
`jira.projectMap` is skipped rather than treated as an error.

### Picking one

`jira.projectMap` is source 2, and it has a UI - you do not have to write the JSON.

The Project pane's caption is a button. With no key resolved it reads "Choose a project..."; with
one it names the key and which of the four sources supplied it. Clicking it lists the projects on
your Jira site, and picking one writes the mapping for this repository.

Sources 1 and 3 are read *before* the mapping, so when a `.jira-project` file or the environment
variable already answered, the picker says so: your choice is still saved, it just takes effect
once that source is gone. That way a mapping can be prepared before the file is deleted.

In **Settings → Jira** the same mapping is shown as a table directly under the `jira.projectMap`
field - one row per repository, for reviewing and removing them all in one place. Editing the JSON
or the table updates the other. (On a Perch older than settings-component placement, the table and
the API token field both sit at the bottom of the section instead.) If `jira.projectMap` cannot be read, the table says so and
refuses to write rather than replacing text you typed by hand.

Setting **`jira.projectJql` bypasses this entirely** - the query replaces the project section
outright and no key is resolved. The Project pane is captioned `Custom query` instead of the key
when that happens, so the bypass is visible.

## Filters

Each list has a search box, a funnel, and a toggle for picking several tickets at once.

The funnel offers **Status**, **Assignee**, **Type** and **Priority**. Assignee is offered on the
Project list only - the other list is one person by definition. The values come from Jira's own
metadata for the repo's project, not from the tickets currently on screen, so a status with no
loaded ticket is still there to pick. A facet Jira cannot answer for is left out rather than
shown empty.

**Filters narrow the query, not the rows on screen.** They become JQL clauses on top of whatever
query the list already runs - including your own `jira.jql` or `jira.projectJql` - so they search
the whole backlog rather than the `jira.maxResults` tickets that happen to be loaded. The search
box matches the summary, and matches the issue key as well when you type something shaped like
one, so `CAP-12` finds that ticket whatever its summary says.

What is active shows as chips under the row; a chip's x removes that one value and **Clear**
removes them all.

Filters are remembered per repository and per list, so a project reopens under the filters you
left it with. They live in a `jira.filters` key in the settings document, which Perch syncs - so
the same filter is there on your phone. It has no row in the settings table below on purpose: it
is rewritten every time you tick a box, and **Clear** is how you reset it.

## Sorting

Either list can be sorted by **Key**, **Summary**, **Status**, **Priority**, **Assignee**, **Type**,
**Created** or **Updated**, in either direction - from the Sort control in the funnel popover, or in
the editor tab by clicking a column heading (click it again to flip the direction). The default is
Updated, newest first, which is the order the lists always had.

**Sorting asks Jira, like the filters do.** The choice becomes the query's `ORDER BY`, so sorting by
key gives you the lowest keys in the backlog, not the `jira.maxResults` newest tickets shuffled. While
a sort is chosen it replaces the `ORDER BY` of a custom `jira.jql` or `jira.projectJql`. Tickets that
tie on the sorted field are ordered by key, so they never swap places between reloads.

## Grouping by project

The Group control splits a list into one section per Jira project, headed by the project's key, name
and ticket count, in the order each project first appears in the sorted list. A section's heading
collapses and expands it. Shift-click ranges follow what is on screen, so they skip collapsed sections.

Sort and grouping are remembered per repository and per list - in a `jira.listViews` key the panel
writes, apart from the filters, so **Clear** resets the filters and leaves the sort alone.

## Board

The editor tab's **Table / Board** switch lays the list out as a kanban board instead: one column per
group of statuses, cards in the chosen sort order within each column, and - with Group by project on
- one swimlane per project. A card shows the key, summary, type, priority and the assignee's
initials. Clicking it opens the ticket in the details pane; Ctrl-click or its checkbox adds it to the
selection, so Start work and Add to worktree act on board picks too. On a phone, press and hold a
card, or turn on the select toggle, and taps then pick cards instead of opening them. Cards can't be dragged: the board
shows where tickets are, and changing a ticket's status stays in Jira.

**Columns.** **Edit columns** on the board lets you add, rename, reorder and remove columns, give each
one a colour from a small palette (shown as a bar over its title and a light wash behind its cards),
and choose which statuses each one holds; a status can be in one column only. When a column holds
more than one status, each of its cards shows its own status. The configuration is one board for
every project and both lists, saved in a `jira.board` key the panel writes (it syncs like the rest of
your settings). Until you set it up, every status is its own column, To Do statuses first and Done
last.

As you scroll a board, each column scrolls only until its last card is in view, then holds there
while longer columns carry on - so every card in a column is reachable without scrolling to the end
of the longest one, and a short column stays in view beside a long one.

**Statuses no column claims** get a column of their own, named after the status, but only while a ticket
on the board has that status. Your columns always come first; these follow, To Do statuses first and
Done last. Tick **Hide statuses that aren't in any column** in the editor to leave them off the board
instead - the toolbar then says how many tickets it is hiding.

In the editor, each column's **Statuses** button opens a searchable checklist of every status: tick
as many as you like and untick to take one out. A status another column already holds is greyed out
and names that column; untick it there to move it. **Save** is in the editor's header, which stays in view however many columns you add.

**What the board loads.** The board fetches up to `jira.boardMaxResults` tickets (100 by default) and
also shows tickets that reached Done in the last `jira.boardDoneDays` days (14 by default; 0 shows
none), so a Done column shows recent movement. The table and the sidebar keep `jira.maxResults` and
leave Done out, as before. A custom `jira.jql` or `jira.projectJql` is used on the board exactly as
written - the extension can't safely change your own query to let finished tickets back in.

## Several tickets, one worktree

Tickets can be picked in bulk and sent to a single worktree.

| Gesture | Does |
|---|---|
| Point at a row | Shows its checkbox |
| The toggle in the filter row | Shows every checkbox, on desktop and touch alike |
| Ctrl-click or Cmd-click a row | Adds or removes that one |
| Shift-click a row | Takes the run from the last row you touched |
| Drag across rows | Rubber-band selection. Ctrl or Cmd adds to what was already picked; Escape puts it back |
| Press and hold a row | Starts a selection on touch |

The selection is shared by both lists, so a ticket listed in each is one ticket and counted once.
With nothing picked, clicking a row still opens its details as it always did.

Once anything is picked, a bar appears with **Start work**, **Add to worktree** and **Clear**.

**Start work** on several tickets opens a small form: the branch, prefilled by applying
`jira.branchTemplate` to the first ticket and editable, the resolved worktree path, and which
agent to start. It creates **one** worktree and hands the agent **one** message carrying every
ticket in full, in the order they were picked. A branch that already exists is reported in the
form, which stays open so you can rename it. One ticket on its own never shows this form - that
is still a single click.

## Adding tickets to a worktree that already exists

**Add to worktree** lists every checkout of the repository with what is running in it:

```
CAP-99-nav-overflow          agent running
feature/billing-backfill     session, no agent
main                         no session
```

A worktree whose agent is already running takes the tickets straight away and nothing is
created. One with a session but no agent, or with neither, gets what it is missing first, asking
which agent the same way "Start work" does. The tickets arrive as one message, the same brief
described below.

For a single ticket without picking anything, right-click its play button.

## Fewer requests

A ticket you have opened is kept for `jira.detailCacheSeconds` (five minutes by default), so opening
it again - in the popover, the editor tab, or when its brief is built for an agent - shows it at
once without asking Jira again. After that it is fetched fresh, and expired entries are cleared
every minute. The refresh button on an open ticket skips the cache, and moving a ticket to In
Progress, or switching Jira site, account or `jira.commentLimit`, forgets the cached copies.

Changing a filter reloads the two ticket lists and nothing else. Settings that don't change what is
fetched - the saved filters, the branch template, the cache time itself - don't reload anything.

## Editor tab

The sidebar is narrow, so the same lists also open as an editor tab: the **Open in an editor tab**
button at the end of either pane's filter row, the Jira icon in the status bar, or **Jira: Open in
Editor Tab** from the command palette. The status bar icon can be turned off with
`jira.showStatusBarIcon`; hovering it shows how many tickets are assigned to you.

The tab switches between **Assigned to me** and **Project**, lays each ticket out as a table row
with a column per field (key, summary, status, assignee, type, priority, updated), and opens the
ticket you click in a pane beside the list rather than in a popover. **Add to worktree** and **Start
work** for that ticket sit on the right of the Assigned to me / Project bar; once you tick rows, the
same spot acts on the selection instead.

The two buttons at the right end of that bar put the details **beside** the list or **below** it.
Until you pick one, the tab decides by its width, stacking them when it gets narrow. Drag the
divider between the list and the details to resize them (arrow keys work on it too, and a
double-click resets it). The layout and the size are remembered in this browser. As the list itself
narrows, assignee, type and priority are hidden first, then status and the date.

A ticket's description and comments are shown formatted - headings, lists, code blocks, tables,
links, mentions and checklists - because the extension converts Jira's rich text to Markdown. The
agent receives the same Markdown in its brief.

It reads the same state as the sidebar, so filters, the selection and every gesture above work
the same in both, and a filter set in one is already set in the other.

There is one Jira tab per project. Perch's tab bar shows one project at a time and keeps each
viewer tab with the project it was opened from, so each project gets its own Jira tab, and it always
shows that project.

## "Start work"

Creates a worktree branched off the repo's **default branch** - `origin/HEAD` if it is set,
otherwise whatever `git remote show origin` reports - after fetching `origin`. If neither can
answer (a `--depth` clone, an origin added by hand, no remote at all) it falls back to the
current HEAD and says so in the panel; `git remote set-head origin -a` fixes the common case.

The branch name comes from `jira.branchTemplate`:

| Token | Becomes |
|---|---|
| `{key}` | the issue key, e.g. `CAP-123` |
| `{slug}` | a short slug of the summary, e.g. `fix-header-alignment` |
| `{type}` | `bugfix` for a Bug issue type, `feature` otherwise |

So `{key}-{slug}` gives `CAP-123-fix-header-alignment`, and `{type}/{key}` gives
`feature/CAP-123`.

The worktree is then opened as a session, and an agent from **Settings → AI Providers** is started
in it and handed a brief as a second message: the issue key, summary, type, status, priority,
labels, link, description and the most recent comments (up to `jira.commentLimit`, oldest
first). Several tickets arrive as one message: a heading naming every key, then each ticket's
brief in full. With more than one agent configured, Start work opens a menu to pick which, and "No
agent (worktree only)" skips starting one. Whether the agent runs without permission prompts
is not asked here: the app's one Yolo/Manual switch in **Settings → AI Providers** decides it.
The agent's launch command is always submitted; the issue context follows
`jira.sendAutoSubmit` (default off - you review before pressing Enter).

With `jira.updateIssueOnStartWork` on, it also moves the issue to `jira.inProgressStatus` and
assigns it to you if it is unassigned - every ticket, when there is more than one, and one that
fails leaves the rest moved. Neither is fatal: the worktree exists either way, so a
Jira-side failure is reported as a note in the panel rather than as a failed "Start work".

## Settings

| Key | Default | Description |
|---|---|---|
| `jira.siteUrl` | `""` | Your Jira Cloud site. Must be https |
| `jira.email` | `""` | The Atlassian account email the API token belongs to |
| `jira.projectKey` | `""` | Fallback project key, used when no file, map entry or env var applies |
| `jira.projectKeyFile` | `.jira-project` | Repo-root file whose contents are the project key - the first source consulted |
| `jira.projectKeyEnv` | `JIRA_PROJECT_KEY` | Environment variable read for the project key |
| `jira.projectMap` | `{}` | JSON object mapping a repo root path to a project key |
| `jira.jql` | `""` | Replaces the "assigned to me" query. Empty means `assignee = currentUser() AND statusCategory != Done` |
| `jira.projectJql` | `""` | Replaces the project query, bypassing the project-key chain |
| `jira.maxResults` | `30` | How many issues each section fetches |
| `jira.boardMaxResults` | `100` | How many issues the editor tab's board fetches per list |
| `jira.boardDoneDays` | `14` | Days a finished ticket stays on the board. `0` shows no Done tickets |
| `jira.commentLimit` | `20` | How many of the issue's most recent comments "Start work" hands the agent. `0` sends none |
| `jira.detailCacheSeconds` | `300` | How long an opened ticket's details are reused before being fetched again. `0` turns caching off |
| `jira.branchTemplate` | `{key}-{slug}` | Branch name for "Start work" - `{key}`, `{slug}`, `{type}` |
| `jira.worktreeLocation` | `{repo}/.worktrees/{branch}` | Where "Start work" creates its worktree - same convention as the app's own worktree location (Settings → Behavior) |
| `jira.showStatusBarIcon` | `true` | Show a Jira icon in the status bar that opens the editor tab |
| `jira.sendAutoSubmit` | `false` | Submit the issue context to the agent immediately, instead of typing it for review |
| `jira.updateIssueOnStartWork` | `false` | Let "Start work" transition and assign the issue in Jira |
| `jira.inProgressStatus` | `In Progress` | Target status for that transition |

The API token is entered in this extension's Settings section but is not a setting - see
[Where the token is kept](#where-the-token-is-kept).
