# Agent Usage Monitor

How much each coding agent has burned, in the status bar. Everything shown is read from files the agents already write on this machine; the extension writes nothing and sends nothing anywhere.

## What you get

Three status-bar items, each one switchable in Settings:

- **Claude usage** - the 5-hour and weekly limits, with the percentage used and how long until each resets.
- **Codex usage** - the window Codex itself reports, when it reports one.
- **Model** - the model running in the terminal you are looking at, by name only (`opus-5`, not `claude-opus-5-20251001`). It hides for a plain shell; the agent and folder are in its tooltip.

Clicking any of them opens the same view: for each agent, its limits, what it has spent, the current block's tokens and burn rate with a per-model breakdown, and the blocks before it.

## What each agent reports

| | Tokens | Cost | Limits |
|---|---|---|---|
| Claude Code | per message, with timestamps | its own USD figure, per session | 5-hour and weekly |
| Codex | cumulative per session | none, so the view says so rather than guessing | whatever window its files carry |

An agent with no readable usage never appears, so nothing sits empty in the bar. Cost is never estimated from a price table: it is the agent's own number or nothing.

## Where the numbers come from

- `~/.claude/projects/**/*.jsonl` - token usage per message, and each session's `cost-state` summary line. Only transcripts touched inside the window on screen are read line by line; the rest are read as a tail for their cost line, so a 500 MB folder costs a fraction of a second.
- `~/.claude/rate-limit-state.json` - the limit percentages Claude Code records for itself.
- `~/.claude/sessions/<pid>.json` - which Claude session runs in which pane, for the model item.
- `~/.codex/sessions/**/rollout-*.jsonl` - cumulative token counts per turn, plus Codex's own limit block. The running `codex` process holds its rollout open, which is how its terminal is matched to a session.

## Auto-continue

This extension does not resume a session after a usage limit. Claude Code does that itself: set `autoContinueAtUsageLimit` to `true` in `~/.claude/settings.json`. It replaces Claude Usage & Auto-Retry, which did both jobs.
