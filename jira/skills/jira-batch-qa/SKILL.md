---
name: jira-batch-qa
description: 'Check a Jira batch ticket before reporting it done: does the change do what the ticket asked and nothing else, does it look right on screen, and what evidence proves it. Use when working tickets in a Jira batch cluster, before running jira-batch done.'
---

# QA for a batch ticket

This is the Jira extension's **fallback** QA procedure. It is used because no
other QA skill was chosen for this cluster. If you have your own - a visual QA
skill for this stack, a house checklist - install it and pick it in
**Settings -> Jira -> QA skill**, and it replaces this entirely.

It covers QA only. How to *implement* a ticket is the execution skill's job,
and what to report through `jira-batch` is in your cluster brief
(`jira-batch brief`).

## What QA is for here

Someone else is going to read your report and decide whether to accept the
work without opening the code. Everything below exists to make that decision
possible for them, which is a different goal from convincing yourself the
change works. Two consequences worth holding onto:

- **A claim without evidence is an assertion.** If you could not capture the
  state, say so and mark the ticket `blocked` - that is a real, useful answer.
  A `pass` nobody can check is worse than an honest `blocked`.
- **Report what failed.** A cluster where every ticket passes is suspicious.
  The failures are the part the reviewer actually needs.

## 1. The code check

Read your own diff before anything else - `git show` for the commit you just
made, not `git status`, which tells you what changed but not what you did.

- Does it do what the ticket asked? Compare against the ticket's own words,
  not against your memory of them.
- Does it do anything the ticket did **not** ask for? An unrelated
  refactor, a stray formatting sweep, a debug line, a file from another
  ticket - all of these make the change harder to review and harder to revert.
- Is anything in it generated? Build output, a lockfile you did not mean to
  touch, a minified asset. If the repo builds artifacts, they do not belong in
  a ticket commit unless the ticket is about them.

Anything you find here is worth fixing before you report, not worth mentioning
in the report as a known flaw.

## 2. The visual check

**Only when the ticket concerns something you can see.** A config change, a
backend fix or a docs edit has nothing to photograph, and inventing a
screenshot for it wastes everyone's time - go to step 4 and report `pass`
with steps a reviewer can follow instead.

What to open is **the ticket's business**: the URL, page, component or state
it names. If the ticket names nothing and you cannot tell what would show the
change, that is worth saying in the report rather than guessing.

Start the app the way this repository starts it - its README, its
`package.json` scripts, or the dev-server skill for this stack if one is
installed. Capture at a real viewport size and do not shrink the image
afterwards: a screenshot that has been scaled down cannot be zoomed back into
evidence, and the reviewer's whole reason for opening it is to check a
padding, an alignment or a blurry edge for themselves.

### Before and after

You will nearly always have made the change already by the time you think
about the "before" picture. Get it from a scratch checkout rather than by
undoing your work:

```sh
# a throwaway checkout of the commit this ticket started from
git worktree add --detach /tmp/qa-before-<KEY> <base-commit>
# run the app there, on a different port from your own, and capture
git worktree remove /tmp/qa-before-<KEY>
```

If `ticket-worktree` is installed (it comes with `execute-jira-ticket`), use
it instead - it knows this repository's conventions and cleans up after
itself.

Two mistakes to avoid, both of which produce a report that looks fine and
proves nothing:

- **Capturing the wrong app.** Two servers are running now - yours and the
  baseline. Confirm which port you are looking at before each capture, and
  label the file as you save it (`<key>-before.png`, `<key>-after.png`)
  rather than deciding later which was which.
- **Capturing a different view.** Same page, same viewport width, same state
  (same cart contents, same logged-in user, same scroll position). A
  before/after pair that differs in two ways demonstrates nothing about
  either.

### More than a pair

A before and an after are the comparison, but they are not a limit. When the
ticket's change shows somewhere else too - a second viewport, a later step in
the flow, a state that only appears on one route - capture that as well and
pass it with `--shot <file>:<caption>`, which repeats:

```sh
jira-batch qa CAP-12 --status pass \
  --before before.png --after after.png \
  --shot mobile.png:"Cart at 390px" \
  --shot drawer.png:"Drawer open after the fix"
```

Caption every one. The reader has your `steps` and nothing else to go on, and
a row of uncaptioned screenshots is a puzzle rather than evidence. Say what
the picture shows, not that it is a picture: "Cart at 390px" over "mobile
screenshot".

Restraint still applies - four shots that each prove something beat eight that
repeat one another, and a shot nobody can tell the purpose of is worse than no
shot at all.

## 3. Writing it down

Three fields do the work. Write them as short bullets, one idea each, because
a reviewer scans bullets and reads paragraphs only if forced to.

| Field | Answers | Keep out |
|---|---|---|
| `problem` | what was wrong, in the reporter's terms | the ticket title restated |
| `fix` | what you changed, by mechanism | intent, "properly", "correctly" |
| `steps` | how someone else reproduces the check | "checked the spacing" |

Lead with the concrete thing - the value, the selector, the file, the event -
and drop the lead-ins ("I found that...", "In order to..."). One line each,
never wrapping past two. If a bullet needs an "and", it is two bullets.

```
problem   Subtotal keeps the old value until the drawer is reopened.
fix       Recompute on the cart:line-item-change event.
          Dropped the cached totals partial.
steps     Open /cart at 1440px
          Change a line item quantity
          Confirm the subtotal updates without reopening the drawer
```

If `problem` and `fix` read as the same sentence inverted, the `fix` is too
vague - name the mechanism, not the intention.

**Steps must be reproducible by someone who was not you**: the URL, the
viewport, where to scroll, what to look at. That is the difference between a
step and a note to yourself.

## 4. Report it

One `jira-batch qa` call per ticket, before `jira-batch done`. Your brief has
the exact flags; `jira-batch help` lists them.

Pick the status honestly:

| Status | When |
|---|---|
| `pass` | you checked it and it does what the ticket asked |
| `fail` | you checked it and it does not |
| `partial` | part of the ticket is done and part is not - say which in `notes` |
| `blocked` | you could not do or could not check it - `problem` and a `notes` line saying why, no `fix` |

A `blocked` ticket is a complete, respectable outcome: a missing third-party
app, a design decision that is not yours, something already fixed on the base
branch, an asset that does not exist in the repo. Report it and move to the
next ticket. Never invent a fix to avoid reporting one.
