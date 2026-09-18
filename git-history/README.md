# Git History

Two read-only views on any tracked file, from the FILES tree's right-click menu:
**Git: File History** and **Git: Blame**. Nothing in this extension changes the
repository or reaches a remote.

## Requirements

- `git` on the server's PATH.

## File History

Lists the commits that touched the file, newest first, following it through
renames (`git log --follow`), with the short SHA, subject, author and age. A row
carries a `renamed` chip where the file arrived under another name; its tooltip
names the old path.

- **On a wide tab the view is two columns**, with a divider you can drag (or
  move with the arrow keys when it has focus) and whose position is
  remembered: the commits on the left, and the change the selected one made
  to this file on the right, so reading down a
  file's history never means opening a tab per commit. It opens on the newest
  commit. Below 900px it falls back to one column, where a row opens the diff
  in whichever editor **Settings → Editor** selects.
- **Open in Editor**, in the diff pane's header, hands the same two revisions
  to that editor when you want its full diff view. Both sides are committed
  content, so it opens read-only.
- **Right-click a row** for *Open Diff*, *View at This Revision* (opens the Blame
  view pinned to that commit) and *Copy SHA*.
- **Load More** pages by 50.

## Blame

Shows the file's lines at HEAD, or at the revision a *View at This Revision*
opened it with, as **blocks rather than annotated lines**. A real file's blame
is a handful of long runs, not many short ones - one 2,600-line source file came
out as 25 blocks - so each run of lines from one commit is drawn as a block of
its own:

- **Alternating shading** separates one block from the next, whatever the theme
  makes of a border colour.
- **An age stripe** runs down the left of each block: warm for the newest
  commits, cool for the oldest, bucketed against this file's own history. A
  glance shows which parts are recent work.
- **The gutter carries the commit's message**, not just its SHA and author,
  because "why is this line here" is the question a blame is opened to answer.
  It also says how many lines the block covers, and it sticks to the top of the
  viewport while you scroll a long block, so the commit you are reading is
  always named.
- **Hovering a block highlights every other block from the same commit**, which
  is how you see one commit's whole footprint in the file.
- **Clicking a block's gutter** opens that commit's diff of the file.

Lines you have edited but not committed form their own block, marked "Not
committed". Two files are refused rather than rendered: one over 2 MB ("Too
large to blame") and one that looks binary ("Binary file").

Both the blame and the history diff are syntax-highlighted, through a Shiki
chunk that loads on first use and follows the active Perch theme, so a file
reads the way the editor renders it. An unsupported language stays plain.

## Notes

- **The menu items are hidden for a folder**, and for a file outside a git
  repository. Repository membership is a git call, but the menu is built
  synchronously, so the answer is cached per folder: the very first right-click
  in a folder this extension has not seen yet may not show the two items. The
  second one does, and the active session's own folder is looked up as soon as
  you switch to it.
- **Renames:** each row opens the file under the name it had at that commit, so a
  diff from before a rename still resolves.
- **Both tabs are a snapshot**, read when you opened them. They do not follow
  later commits or branch switches on their own - history is read from the
  branch that was checked out at the time, so a tab opened on one branch keeps
  showing that branch's view of the file. Press Reload in the tab's toolbar to
  read it again.
