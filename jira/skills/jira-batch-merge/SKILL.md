---
name: jira-batch-merge
description: 'Own a Jira batch''s QA branch: cherry-pick each ticket onto it one at a time, serve it on the dev server, fix what the reviewer flags without committing until they approve, then merge to production. Use when you are the QA agent of a Jira batch, in the QA worktree, reporting through jira-batch qa-* verbs.'
---

# The QA branch

This is the Jira extension's **fallback** procedure for a batch's QA agent. It
runs because no other integration skill was chosen. If you have your own -
a house release procedure, a different stack - install it and pick it in
**Batches -> Integrates with**, and it replaces this entirely.

You are one agent in one worktree, on a branch nobody else touches. Every
git action and every dev-server action in this batch is yours; the panel only
tells you what the reviewer decided. You are told the batch, the branch, the
production branch and the tickets in your brief. Read `jira-batch help` for
the verbs; the ones that are yours start with `qa-`.

The Shopify commands here are **examples**. Another stack serves its worktree
some other way; the shape of the procedure does not change.

## Rules that do not bend

- **Never push.** Not the QA branch, not production, not anything. The
  reviewer pushes when they are ready.
- **One ticket, one commit** on the QA branch, whose subject carries the key:
  `[LIV-341] ...`. However many commits the cluster made, and however many
  rounds of fixes the reviewer asks for, the ticket ends as one commit.
- **A requested change is not committed until it is approved.** Edit the
  worktree, restart the server, say `qa-fixing`, and stop. The reviewer looks
  again. Only on approval does the fix go in - amended into that ticket's
  commit, not as a commit of its own.
- **Report every step** with the verbs below. The board is drawn from what
  you report; an unreported step is a step the reviewer cannot see.

## 1. Starting

Your worktree is already on the QA branch, cut from the production branch.
Confirm it: `git status` and `git log --oneline -3`.

Then take over the dev server. Other agents in this batch may each be running
one from their own worktree; stop every one of them, then start yours here,
so there is one server and it serves this branch:

```sh
# every theme dev server on this machine, whoever started it
pgrep -af 'shopify.*theme dev' | awk '{print $1}' | xargs -r kill
# yours, from this worktree
shopify theme dev --store=<store> --port=9292 > .qa-dev.log 2>&1 &
```

Wait until it answers - `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9292/`
returns 200 - then:

```sh
jira-batch qa-start --url http://127.0.0.1:9292
```

If a server will not stop or will not start, say so with `jira-batch note`
and stop; do not merge anything onto a branch nobody can look at.

## 2. Merging a ticket

The panel types `Merge <KEY>` with the cluster branch it lives on. Its
commits are the ones whose subject starts with `[<KEY>]`, on that branch, in
order:

```sh
git log --reverse --format=%H <cluster-branch> --grep='^\[LIV-341\]'
```

Squash them into one commit here. For one commit that is a cherry-pick; for
several, cherry-pick them all and squash with `git reset --soft` to the
commit before the first, then commit once. The subject is `[<KEY>] <what
the ticket did>`, in the ticket's own words.

Restart the server so it serves the new state, confirm it answers, then:

```sh
jira-batch qa-merged LIV-341 --commit "$(git rev-parse HEAD)"
```

### When the pick conflicts

Read both sides before deciding. A conflict that is mechanical - an import
order, two tickets adding adjacent lines, whitespace - is yours to resolve;
resolve it, keep the ticket's intent, and carry on. A conflict that is a
judgement about what the ticket **meant** - two rules that disagree, a
component both tickets restructured differently - is not yours:

```sh
git cherry-pick --abort
jira-batch qa-conflict LIV-341 --files sections/cart.liquid --why "both tickets restyle the drawer and the results disagree"
```

The ticket's own agent is told. You move on to whatever the panel asks next.

## 3. A requested change

The panel types `Change <KEY>: <what the reviewer wants>`. Make the change in
this worktree. **Do not commit.** Restart the server, confirm it answers, and
look at the page.

The ticket's QA report now describes a page that has moved, so update it in
the same call: the fix you made, the steps to check it now, and fresh
screenshots of what the change affects. Restate only what the change made
wrong - a flag you leave out keeps the old report's value, so the problem
statement and the before shot carry over unless they no longer hold:

```sh
jira-batch qa-fixing LIV-341 --what "hover image no longer resizes" \
  --status pass \
  --fix "Removed the hover scale on .card__media img" \
  --steps "Hover a product card at 1280px: the image stays the same size" \
  --after .backups/qa/LIV-341-after-fix.png \
  --shot .backups/qa/LIV-341-hover.png:"Hovered card at 1280px"
```

A second request before approval is one more edit in the same working tree,
reported the same way. Two requests do not become two commits.

## 4. Approval

The panel types `Approve <KEY>`. If the tree is clean there is nothing to do.
If it carries an uncommitted fix, fold it into the ticket's commit:

```sh
git add -A
git commit --amend --no-edit
jira-batch qa-approved LIV-341 --commit "$(git rev-parse HEAD)"
```

The commit's subject does not change. If the ticket's commit is not the tip
(another ticket was merged after it), amend it with a fixup and an autosquash
rebase over just those commits, and report the ticket's new sha.

### Reopened

The panel may type `Reopen <KEY>` after an approval: the reviewer took it
back. Leave the commit as it is - amended or not - and wait. A change
request or a new approval follows the usual way. If an amend was still in
flight, finish it and report its sha with `qa-approved` as usual; the panel
records the sha and keeps the ticket under review.

## 5. Exclusion

The panel types `Exclude <KEY>`, with the commit to drop when there is one.
Drop exactly that commit - `git rebase --onto <commit>^ <commit>` - restart
the server, confirm, and:

```sh
jira-batch qa-excluded LIV-318 --why "assigned to someone else"
```

Nothing else on the branch moves.

## 6. Shipping

The panel types `Ship into <production branch>` only once every merged ticket
is approved; if you are asked and something is not, say so and stop. Then,
in the **primary** worktree of the repository (not this one):

```sh
git switch <production branch>
git merge --no-ff <qa branch> -m "Merge <qa branch>"
jira-batch qa-shipped --into <production branch>
```

If the production branch moved since the QA branch was cut, rebase the QA
branch onto it first, from this worktree, and resolve as in section 2. Do not
push. The reviewer does.

## 7. Notes on approval

When the reviewer approves with a note, the panel types `Refine the approval
note for <KEY>` with the note, so a teammate who was not here can act on it.
You were there - you merged the ticket, served it and made the changes - so
use what you know: expand shorthand, name what the numbers and elements
refer to, keep every claim exactly as strong as it was - "maybe the client
did it" stays a possibility, never a fact. Change nothing in the worktree.
Answer with:

```sh
jira-batch qa-refined LIV-341 --text "The hero image differs from the Figma file; the client may have replaced it."
```

If you cannot restate it without guessing, answer
`jira-batch qa-refined LIV-341 --as-written yes` and it is posted as typed.

## What you do not do

- Push, tag, or touch a remote.
- Rewrite the cluster branches. Fixes live on the QA branch only.
- Commit a requested change before it is approved.
- Merge a ticket the panel did not ask for, or in an order it did not give.
