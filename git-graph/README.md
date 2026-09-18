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

The lane column, then the refs pointing at that commit, then its subject, author
and age. The current branch's label is filled in; remote branches, tags and
stashes each have their own colour. Lanes keep their colour for their whole
length, so a branch is one column from its tip to the commit it grew from.

The first 300 commits load; **Load More** appends 300 more, up to 2,000 - past
that the button disappears and the toolbar keeps showing how many of the
repository's commits are drawn (for example "2000 of 12431"). Rows are
virtualized, so scrolling costs the same at 2,000 commits as at 300; the page
only ever holds the rows you can see.

- **Click a row** to expand the files that commit changed, with their added and
  removed line counts. Clicking a file opens that file's diff at that commit in
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

An operation that stops on a conflict is not reported as a failure: the tab says
which operation stopped and points at **SOURCE CONTROL**, where the bundled Git
extension's conflict resolver lives.

## Settings

- **Poll interval** (`gitGraph.pollInterval`, default 5000ms) - how often the
  open tab checks whether any ref moved. It reloads only when one did, and it
  polls only while the tab is the active one, so a graph left open in a
  background tab costs nothing.
- **Show remote branches** (`gitGraph.showRemoteBranches`, default on) - include
  remote-tracking branches. Off draws only local branches, tags and stashes.

## Notes

- **Deleting a remote branch reaches the network without a credential prompt.**
  It works with an SSH agent or a configured credential helper, and otherwise
  fails with git's own message. The bundled Git extension's BRANCHES pane runs
  the same operation through a credential relay that can ask you interactively -
  use that one on a remote that needs a password.
- **The graph is not a working-tree view.** Staging, committing and resolving
  conflicts stay in the Git extension's SOURCE CONTROL panel; this tab is about
  history and refs.
