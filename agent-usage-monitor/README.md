# Agent Usage Monitor

How much each coding agent has burned, in the status bar. Everything shown is read from files the agents already write on this machine, or asked of the agent's own CLI (`claude -p /usage` and `codex app-server`, each once a minute); the extension writes nothing and sends nothing anywhere.

## What you get

Three status-bar items, each one switchable from the status bar's right-click menu, the gear menu's Status Bar list, or Settings:

- **Claude usage** - the 5-hour and weekly limits, with the percentage used and how long until each resets, plus the per-model weekly cap where the account has one.
- **Codex usage** - the windows Codex itself reports, when it reports any.
- **Model** - the model running in the terminal you are looking at, by name only (`opus-5`, not `claude-opus-5-20251001`). It hides for a plain shell; the agent and folder are in its tooltip.

Clicking an item opens its agent's view (the model item opens the view for the agent running there): its limits, what it has spent, the current block's tokens and burn rate with a per-model breakdown, and the blocks before it.

On a phone's compact status bar the reset countdowns drop out and the percentages stay.

## What each agent reports

| | Tokens | Cost | Limits |
|---|---|---|---|
| Claude Code | per message, with timestamps | its own USD figure, per session | 5-hour, weekly, and per-model weekly |
| Codex | cumulative per session | none, so the view says so rather than guessing | whatever windows the CLI reports, else what its files carry |

An agent with no readable usage never appears, so nothing sits empty in the bar. Cost is never estimated from a price table: it is the agent's own number or nothing.

## Where the numbers come from

- `~/.claude/projects/**/*.jsonl` - token usage per message (subagent runs included), and each session's `cost-state` summary line. Only transcripts touched inside the window on screen are read line by line; the rest are read as a tail for their cost line, so a 500 MB folder costs a fraction of a second.
- `~/.claude/rate-limit-state.json` - the limit percentages Claude Code records for itself.
- `~/.claude.json` - Claude Code's cached copy of the account's limits, which is where the per-model weekly cap lives.
- `claude -p /usage` - run once a minute while a client is polling, because the two files above only move while a Claude Code session is running. The run prints the account's limits and exits, rewriting both files on the way out; its output is discarded and the files are read as before. It leaves no transcript (session persistence is off) and starts no MCP servers. A machine without `claude` on the server's PATH pays one failed spawn a minute and shows whatever the files say.
- `~/.claude/sessions/<pid>.json` - which Claude session runs in which pane, for the model item.
- `~/.codex/sessions/**/rollout-*.jsonl` - cumulative token counts per turn, plus Codex's own limit block. The running `codex` process holds its rollout open, which is how its terminal is matched to a session.
- `codex app-server` - asked for the account's current limits, plan and today's token count, the same numbers Codex's own UI shows. Its answer wins over the rollout files, which stopped carrying usage; the files remain the fallback when it doesn't answer. The account token stays inside Codex's process.

## Auto-continue

This extension does not resume a session after a usage limit. Claude Code does that itself: set `autoContinueAtUsageLimit` to `true` in `~/.claude/settings.json`. It replaces Claude Usage & Auto-Retry, which did both jobs.
