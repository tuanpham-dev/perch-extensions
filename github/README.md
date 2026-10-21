# GitHub

A GITHUB sidebar tab listing the active repo's pull requests and issues, with a
"Start work" action per row that creates a worktree session for it — optionally
priming an agent on it. Backed by the `gh` CLI; the extension holds no credentials of
its own.

## The panel

- **Mine / All**: Mine is the pull requests you opened and the issues assigned to you.
- **State**: pull requests can be shown open, closed, merged or all (gh counts merged
  PRs as closed too); issues open, closed or all.
- **Load more** under a list fetches the next 30 rows. Lists are no longer capped at 30.
- **Refresh** (in the panel header) reloads the repo and both lists, keeping as many
  rows as are showing. A reply that arrives after a newer request was made is
  dropped, so a slow answer for an old filter or an old window never replaces the
  current one.

## Requirements

- The [`gh` CLI](https://cli.github.com/) installed and on `PATH`.
- `gh auth login` run once on this machine.

When something is wrong the panel says which problem it is: gh is not installed,
GitHub can't be reached, gh is not signed in, or the folder is not a GitHub repository
(no GitHub remote, several remotes and no `gh repo set-default`, or not a repository
at all). gh's own message is shown underneath.

## "Start work"

Creates a worktree — for an issue, a new branch off the repo's default branch (after a
`git fetch origin`; falls back to the current HEAD, with a note, when origin has no
default branch); for a PR, the PR's head in a local `pr-<n>` branch — opens it as a
session, then starts an agent from **Settings → AI Providers** and hands it a brief as
a second message: the title, link and description (for a PR also its head and base
branches, and the fork it came from).

A PR's head is fetched the way `gh pr checkout` finds it: the head branch from the
repository it lives in (the contributor's fork, for a fork PR), through a remote that
already points there or else by URL in gh's own git protocol, falling back to GitHub's
`refs/pull/<n>/head` on the base repository (which still works after a fork is
deleted). Nothing assumes the base repository is called `origin`. A new `pr-<n>`
branch tracks the PR's head branch, so `git pull` in it follows the PR.

If the PR or issue already has a worktree, "Start work" uses it instead of creating
another, and if a session is already open on that worktree it simply switches to it
(no agent picker, no second agent). A PR's worktree is its `pr-<n>` branch, or for a
PR from this same repository a checkout of its head branch; an issue's is any
`issue-<n>-*` branch, so renaming the issue doesn't lose it. With more than one agent enabled there, "Start
work" asks which one to use (or none). That list is the app's own, shared with every
other extension that needs to know what an agent is, so there is nothing to configure
here.

Starting work on the same PR again reuses its `pr-<n>` branch: fast-forwarded to the PR
head when that loses nothing, otherwise left as is (local commits are never discarded)
with a note saying so. The agent's launch command is always submitted; the
issue/PR context follows `github.sendAutoSubmit` (default off — you review before
pressing Enter).

## Settings

| Key | Default | Description |
|---|---|---|
| `github.worktreeLocation` | `{repo}/.worktrees/{branch}` | Where "Start work" creates its worktree - same convention as the app's own worktree location (Settings → Behavior) |
| `github.sendAutoSubmit` | `false` | Submit the issue/PR context to the agent immediately, instead of typing it for review |
