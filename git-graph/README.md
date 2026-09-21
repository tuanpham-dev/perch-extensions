# Git Graph

A **GRAPH** tab for the active repository: every branch's commits as a lane
graph, with their branch, remote and tag labels, and the operations a commit or
a label invites.

## Requirements

- `git` on the server's PATH.

## Opening it

- **Git Graph: Open** in the command palette (`Ctrl+Shift+Alt+G` by default).
- The graph icon in the status bar, which appears whenever the active terminal's
  folder is inside a repository and is hidden when it isn't.

One tab per repository: opening it again focuses the tab that is already there.
It opens in the editor area rather than the sidebar because a graph with ref
labels needs the width.

## What a row shows

The lane column, then the refs pointing at that commit, then its subject, author,
age and short hash. The current branch's label is filled in; remote branches, tags and
stashes each have their own colour. Lanes keep their colour for their whole
length, so a branch is one column from its tip to the commit it grew from.

The first page loads 300 commits (**Commits per page**); **Load More** appends
another page, up to 5,000 - past that the button disappears and the toolbar
keeps showing how many of the repository's commits are drawn (for example
"2000 of 12431"). Rows are virtualized, so scrolling costs the same at 5,000
commits as at 300; the page only ever holds the rows you can see.

- **Click a row** to expand the files that commit changed, with their added and
  removed line counts. The lanes carry on down beside the list, so the graph
  stays joined while it is open. The button at the right of the toolbar row
  switches the list between one path per row and a folder tree (folders
  collapse on click, and a folder holding only one folder is shown as one row,
  `src/components`). Clicking a file opens that file's diff at that commit in
  whichever editor **Settings → Editor** selects, read-only. A merge commit's
  file list is read against its first parent - what the merge brought in.
- **Right-click a row** for *Copy SHA*, *Copy Message*, *Checkout* (detached),
  *Create Branch Here*, *Create Tag Here*, *Cherry-pick*, *Revert* and the three
  *Reset Current Branch to Here* modes. Only the destructive ones ask first:
  checkout, because a detached HEAD surprises people, and a hard reset, which
  says that uncommitted changes are discarded. Reset is absent on a detached
  HEAD, where there is no branch to move.
- **Right-click a ref label** for what applies to that ref: *Switch to Branch*
  and *Delete Branch* on a local one, *Checkout as Local Branch* and *Delete
  Remote Branch* on a remote one, *Delete Tag* on a tag. Every delete confirms
  first, and a branch git refuses to delete because it isn't merged asks again
  before forcing.

## Narrowing what it draws

Two menus sit in the graph's own toolbar row at the top of the tab, just right
of the Find button, with the commit count and the list/tree switch at the other
end of the row (the tab bar itself only gets Reload). Each menu remembers its choice per repository, so a graph you narrowed is still narrowed when you come
back to it - the settings below are only what a repository starts from.

- **Branches** lists every local branch, remote branch and tag, with a filter
  box over them. Tick as many as you like and the graph walks exactly those;
  *All branches* clears the selection. Under them are *Show remote branches*,
  *Show tags* and *Show stashes*, which decide what "all" means and are
  therefore greyed out while specific refs are ticked.
- **Authors** lists the people who wrote the commits in whatever the Branches
  menu is showing, most commits first, and shows only the ones you tick. The
  list is built from the most recent 5,000 commits of that scope.

Picking an author leaves out the commits in between the ones you kept, so their
parents are no longer on screen. Rather than draw lines to commits that aren't
there, the graph hides its lane column while an author filter is on and shows
the short hash instead.

## Finding a commit

`Ctrl+F` (or the magnifier at the left end of the toolbar row) opens the find
bar. It matches the
subject, the author, a ref label, or the start of the hash, against the commits
already loaded - **Load More** to search further back.

- Matched rows are highlighted where they sit, so the graph around them stays
  readable. `Enter` and `Shift+Enter`, or the arrow buttons, step through them
  and scroll each one into view; the readout counts them ("3 of 12").
- **Filter** hides everything that doesn't match. Nothing is re-read from git -
  it is the same matches, alone - and because the rows in between are gone the
  lane column gives way to the short hash, the same as under an author filter.
- `Escape` closes the bar and restores the full list.

## Uncommitted changes

Whenever the working tree has staged, unstaged or untracked changes, an
**Uncommitted Changes (N)** row sits above HEAD, joined to it by a grey dashed
line with a hollow dot - it is not a commit yet. Expanding it lists every file a
commit right now would record; untracked files are marked `U` and a file with an
unresolved merge `!`. Clicking a file opens HEAD against the file on disk, and
the working-tree side is editable. The row follows your edits: the open tab
checks the working tree on every poll tick and refreshes the row only when
something changed.

The row is left out while the lanes are hidden (an author filter, or the find
bar's Filter) and when HEAD isn't among the loaded commits, since there is then
nothing to join it to.

An operation that stops on a conflict is not reported as a failure: the tab says
which operation stopped and points at **SOURCE CONTROL**, where the bundled Git
extension's conflict resolver lives.

## Settings

- **Poll interval** (`gitGraph.pollInterval`, default 5000ms) - how often the
  open tab checks whether any ref moved. It reloads only when one did, and it
  polls only while the tab is the active one, so a graph left open in a
  background tab costs nothing.
- **Show remote branches** (`gitGraph.showRemoteBranches`, default on), **Show
  tags** (`gitGraph.showTags`, default on) and **Show stashes**
  (`gitGraph.showStashes`, default on) - what a repository's graph includes the
  first time it is opened. The Branches menu overrides all three per
  repository.
- **Only follow the first parent** (`gitGraph.firstParent`, default off) - draw
  the mainline only, leaving out the commits each merge brought in. Unlike an
  author filter this keeps the lanes honest: git rewrites the history it walks
  rather than dropping commits out of the middle of it.
- **Commits per page** (`gitGraph.commitsPerPage`, default 300) - how many
  commits each load fetches. Larger pages mean fewer round trips and a longer
  wait for each one.
- **Date style** (`gitGraph.dateStyle`, default relative) - whether the date
  column reads "3 days ago" or the calendar date. The other form is always in
  the row's tooltip.
- **Show the hash column** (`gitGraph.showHashColumn`, default on) - each
  commit's short hash as the last column. It stays visible whenever the lanes
  are hidden.
- **Show uncommitted changes** (`gitGraph.showUncommittedChanges`, default on) -
  the Uncommitted Changes row above HEAD.
- **File view** (`gitGraph.fileView`, default list) - an expanded commit's files
  as a list or a folder tree. The toolbar's switch writes this same setting.

## Notes

- **Deleting a remote branch reaches the network without a credential prompt.**
  It works with an SSH agent or a configured credential helper, and otherwise
  fails with git's own message. The bundled Git extension's BRANCHES pane runs
  the same operation through a credential relay that can ask you interactively -
  use that one on a remote that needs a password.
- **The graph is not a working-tree view.** Staging, committing and resolving
  conflicts stay in the Git extension's SOURCE CONTROL panel; this tab is about
  history and refs.
