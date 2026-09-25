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

The fetch is best effort. When the remote cannot be reached - no key deployed for it on this
host, no network, a credential prompt behind the timeout - the worktree is still created from
the local base, and the panel says which base it used and what git reported. Nothing about
starting work waits on the remote's permission.

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

## Batches

"Start work" gives one worktree to one agent. A **batch** splits a pile of tickets
across several - each cluster gets its own worktree, its own agent, and its own place on
a board - and keeps them supervised from the **Batches** view while you review what comes
back.

It runs on the server. Close the browser and the agents carry on; the board is where they
were when you come back.

### Planning one

Tick some tickets and press **Plan batch**, or use **Jira: Plan Batch** from the command
palette with nothing ticked. The form takes tickets from two places at once:

- what you ticked in either list (**Select all** takes everything the current filters left);
- anything you paste into the **ticket keys** field - keys, browse URLs, lowercase,
  separated by commas, spaces or newlines, from any project on the site. Keys nobody can
  see are reported by name rather than silently dropped.

Then say how to split them. The criteria box is an instruction to the AI, not a filter;
it is remembered per repository.

**Read the codebase** lets the AI look at the code each ticket would touch before
grouping, and list those files on each cluster. It is the difference between grouping by
what tickets *say* and grouping by what they *touch*, which is what keeps two agents out
of the same file. Only an agent CLI can do it - a keyed API has no tools, and the box
says so. It needs a Perch new enough to let one AI call run past 60 seconds; on an older
one the analysis stops there and the form offers to run without it.

With no AI configured at all, tickets are grouped by epic, then component, then label,
and the panel says that is what happened.

### Reviewing the clusters

The proposal opens as columns you can still change: rename a cluster, drag a card (or use
the card's menu, which is also the touch and keyboard path), add a cluster, delete one -
its tickets return to **Unclustered** rather than leaving the batch. Nothing in
Unclustered is ever executed. Each cluster shows the AI's reasoning, the files it expects
to touch, and an editable branch name from `jira.clusterBranchTemplate`.

Tick the clusters to run, pick an agent, and press **Start**. Clusters start one at a
time, and a branch name that is taken stops that one cluster - it stays startable, with
the reason on its row - rather than the batch.

### What starting one does

Per cluster, on the server: a worktree on a new branch off the repository's default
branch, a session named after that branch, and the agent launched in it. Its tickets
follow `jira.updateIssueOnStartWork` exactly as "Start work" does.

The brief rides **on the launch line** as the agent's first prompt. It cannot follow as a
second message: the agent takes seconds to come up and may ask something first (Claude
Code asks whether it trusts the folder), and anything typed meanwhile lands in the shell
instead, where the agent never sees it. So the line carries the tickets, the order and
the rules, and tells the agent to run `jira-batch brief` for the full text.

### The board

The **Batches** view lays every ticket out by what its agent last reported:

| Column | Means |
| --- | --- |
| Queued | Not started yet - including tickets whose cluster has not been started |
| In progress | The agent said it is on this one |
| Needs you | It is blocked: a permission prompt, or a turn that ended mid-ticket |
| Review | The agent says it is done; read it |
| Rework | You sent feedback and it is being worked again |
| Done | You accepted it |
| Failed | The agent said it could not do it, with a reason |

All seven are always drawn, however empty: "nothing in Needs you" is information.

One **chip per cluster** does two jobs - it says how that agent is doing (running, waiting
on you, idle, stopped), and clicking it filters the board to that cluster. Right-click a
chip (or use its button) for what the cluster can do right now: open its terminal, stop
it, resume it, close it, remove its worktree. A cluster that has not started shows
**Start** there instead.

The board updates as it happens, over a stream from the server - no polling, no reload.
The JIRA tab and the status bar carry a count of what is back with you.

### Reviewing the work

Click a card to read its ticket, with a **Batch** section underneath: where it has been,
what the agent said it did, any feedback you have already sent, and a box to write more.
Feedback is saved as a draft on the server as you type it.

**Send feedback** sends every draft at once: one message per cluster, typed into that
cluster's terminal, and those tickets move to **Rework**. A cluster whose agent is gone
keeps its drafts rather than losing them to a send that went nowhere, and says so.
**Accept** moves a reviewed (or failed) ticket to Done. Nothing here touches Jira.

### The two skills a cluster runs with

The extension decides **what** a cluster's agent must report and through which verbs. It
does not decide **how** the agent implements a ticket or how it checks its work - those are
a skill's business, and each cluster runs with two of them:

| Slot | Empty means | Setting |
| --- | --- | --- |
| Implements with | `execute-jira-ticket` if it is installed; otherwise the brief carries a short procedure of its own | `jira.executionSkill` |
| QA with | the extension's own `jira-batch-qa` | `jira.qaSkill` |

Both are pickers - in Settings for every cluster, and in the review bar to override them
for the clusters you are about to start. Each lists what it found in `~/.claude/skills`,
in the repository's `.claude/skills` and in any `jira.skillPaths` entry, with its name,
where it came from and its own description; **Another path...** takes a path to a skill
anywhere else. **None** leaves that half to the agent's judgement, and the extension's
rules - one commit per ticket, no invented fixes, no pushes - still apply.

A skill is never read, parsed or validated here: the brief names it, and whatever it says
is what the agent does. That is also why a skill setting is never taken from a repository -
a skill is instructions an agent follows, and a cloned repo must not be able to supply
them. A chosen skill is used where it sits; nothing is written into the worktree.

The one exception is the bundled `jira-batch-qa`, which lives inside the extension where
no agent can find it: when it is the one in use, it is copied to
`.claude/skills/jira-batch-qa/SKILL.md` in that cluster's worktree, and exactly that path
is added to the repository's `info/exclude` so `git status` stays clean. To own the
procedure instead of the extension owning it, run **Jira: Install the batch QA skill**
from the command palette: it copies the skill into `~/.claude/skills`, where it is yours
to edit and simply one more entry in the QA picker. It will not overwrite an existing
skill of that name without asking.

Which skills a cluster actually started with are recorded on it and named in its chip's
tooltip, so a report that reads oddly can be traced to the procedure that produced it even
after you change the setting.

### QA reports and their evidence

A ticket's QA report shows on its card as a verdict and in the detail pane in full: what
was wrong, what changed, the steps to check it, the files touched, and a before and after
image side by side. A ticket that reached Review or Failed with no report says so, in both
places - `done` still succeeds without one, because a missing report is worth seeing rather
than worth blocking on.

Click an image to open it in a viewer over the tab: scroll or pinch zooms about the
pointer, drag pans, a click toggles fit and 1:1.

| Key | |
| --- | --- |
| `←` `→` | Every shot in the batch, in board order |
| `Z` | Actual pixels |
| `0` | Fit to the pane |
| `Esc` | Close (a click on the backdrop does too) |

Images are copied into the extension's own store as they are reported, so they still show
after the worktree is gone.

When a cluster's last ticket is reported, the extension writes a `qa-report` spec for it
and renders it:

| Path | |
| --- | --- |
| `<primary worktree>/.backups/orchestration/<cluster>-qa-spec.json` | The spec, one entry per ticket, each tagged with the cluster's name |
| `<primary worktree>/.backups/orchestration/screenshots/` | The evidence, beside the spec, by short relative paths |
| `<primary worktree>/.backups/<cluster>-<date>.html` | The rendered report, opened from the chip's menu |

**How many screenshots.** `--before` and `--after` are the pair the report chips as BEFORE and
AFTER. `--shot` adds as many more as the ticket needs, each with its own caption, in the order
given - a second viewport, a later step in a flow, a state that only appears on one route. Up to
12 extras per ticket. They are stored alongside the pair and appear after it, in the panel and in
the report alike; re-reporting a ticket with fewer replaces the lot rather than leaving the old
ones behind.

```sh
jira-batch qa CAP-12 --status pass \
  --before before.png --after after.png \
  --shot mobile.png:"Cart at 390px" \
  --shot drawer.png:"Drawer open, 2560px"
```

It goes to the **primary** worktree, not the cluster's own, so every cluster's report
lands in one place and survives its worktree being removed. **Rebuild QA report** in the
chip menu runs it again from the current reports. Rendering uses
`execute-jira-ticket`'s own `scripts/qa-report` when it is installed, and a vendored copy
otherwise. The specs are shaped so that `ticket-orchestrator`'s `combine_qa_reports.py`
merges several clusters into one report with a filter chip per cluster, unchanged.

### Adding tickets later

Plan batch offers **Add to "<batch>"** while a batch is open. The AI places only the new
tickets - into a cluster that can still take them, or into new ones - and never moves what
an agent already holds. Apply hands them to the running agents as an "Additional tickets"
message; tickets for a cluster that has not started travel with it when it does.

### The `jira-batch` command

Installed to `<config>/perch/bin/jira-batch` and put on each agent's PATH by its launch
line, with the batch and cluster ids in its environment. POSIX `sh` around
`curl --unix-socket`.

| Verb | Does |
| --- | --- |
| `jira-batch start <KEY>` | Say you are starting that ticket |
| `jira-batch done <KEY> --summary <text>` | Say it is finished; the summary is what the reviewer reads first |
| `jira-batch fail <KEY> --reason <text>` | Say it cannot be done, and carry on |
| `jira-batch qa <KEY> --status pass\|fail\|partial\|blocked` | File the QA report: `--problem`, `--fix`, `--steps` (repeatable), `--notes`, `--files`, `--before <path>`, `--after <path>`, `--shot <path>[:<caption>]` (repeatable) |
| `jira-batch note <text>` | Record something against the cluster |
| `jira-batch brief` | Print the cluster's full brief: every ticket, its comments, the rules |
| `jira-batch status` | This cluster and where each of its tickets stands |
| `jira-batch help` | The above |

Any flag value can be `-` to read it from stdin. A report for a ticket this cluster does
not hold, or in a state the verb does not apply to, is refused with a message written for
whoever is reading that terminal.

### When a worker dies

A sweep every 15 seconds marks a cluster **stopped** as soon as its window is gone, and
puts whatever it was mid-way through back in the queue. Only a missing window counts - an
agent that is merely quiet may be thinking. **Resume** opens a new window on the same
worktree, relaunches the agent and tells it where the cluster stands.

Closing a cluster keeps its worktree and branch for review; removing the worktree keeps
the branch, never touches the repository itself, and asks twice if there is uncommitted
work.

### Where it is kept

| Path | |
| --- | --- |
| `<config>/perch/jira/batches.json` | Every batch: tickets, clusters, states, feedback |
| `<config>/perch/jira/batch.sock` | The control socket agents report through |
| `<config>/perch/bin/jira-batch` | The command itself |

The directory is `0700` and the document `0600`; writes are temp-then-rename. Agents reach
the extension over that socket rather than the app's HTTP API, because core deliberately
keeps the app's auth token out of every pane - so anything the Perch user can run can
report on a batch, exactly as it could run the agent itself.

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
| `jira.clusterBranchTemplate` | `{cluster}` | Branch name for a batch cluster - `{cluster}` is the cluster's name as a slug |
| `jira.executionSkill` | `""` | Which skill a cluster's agent implements tickets with. Empty uses `execute-jira-ticket` when it is installed; `none` leaves it to the agent |
| `jira.qaSkill` | `""` | Which skill a cluster's agent checks its work with. Empty uses the extension's own `jira-batch-qa`; `none` leaves it to the agent |
| `jira.skillPaths` | `""` | Extra places to look for skills, one per line - a directory of skills or a single skill directory. `~/.claude/skills` and the repository's `.claude/skills` are always searched |
| `jira.batchAnalysisTimeoutSeconds` | `600` (60-900) | How long the AI may take when it reads the codebase before grouping. Needs a Perch new enough to accept it; older ones stop at 60 seconds |
| `jira.branchTemplate` | `{key}-{slug}` | Branch name for "Start work" - `{key}`, `{slug}`, `{type}` |
| `jira.worktreeLocation` | `{repo}/.worktrees/{branch}` | Where "Start work" creates its worktree - same convention as the app's own worktree location (Settings → Behavior) |
| `jira.showStatusBarIcon` | `true` | Show a Jira icon in the status bar that opens the editor tab |
| `jira.sendAutoSubmit` | `false` | Submit the issue context to the agent immediately, instead of typing it for review |
| `jira.updateIssueOnStartWork` | `false` | Let "Start work" transition and assign the issue in Jira |
| `jira.inProgressStatus` | `In Progress` | Target status for that transition |

The API token is entered in this extension's Settings section but is not a setting - see
[Where the token is kept](#where-the-token-is-kept).
