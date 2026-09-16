# GitHub

A GITHUB sidebar tab listing the active repo's open pull requests and issues, with a
"Start work" action per row that creates a worktree session for it — optionally
priming an agent on it. Backed by the `gh` CLI; the extension holds no credentials of
its own.

## Requirements

- The [`gh` CLI](https://cli.github.com/) installed and on `PATH`.
- `gh auth login` run once on this machine.

Without either, the panel shows a setup hint instead of an error.

## "Start work"

Creates a worktree — for an issue, a new branch off the repo's default branch (after a
`git fetch origin`; falls back to the current HEAD, with a note, when origin has no
default branch); for a PR, the PR's own head ref (fetched by number via GitHub's
`refs/pull/<n>/head` convention) in a local `pr-<n>` branch — opens it as a session,
then starts an agent from **Settings → AI Providers** and hands it the issue's title and
body (a PR's title) as a second message. With more than one agent enabled there, "Start
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
