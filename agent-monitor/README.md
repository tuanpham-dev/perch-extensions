# Agent Monitor

Classifies every terminal window running an AI coding agent and marks that window's own row
in the PROJECTS pane, in the same vocabulary as [Orca](https://github.com/stablyai/orca)'s sidebar:

| Mark | Status | Meaning |
| --- | --- | --- |
| spinner (yellow) | Working | The agent is busy on a task |
| amber **`?`** | Waiting on you | It needs a permission approval or an answer from you |
| emerald dot | Done | The task is finished and the agent is quiet |
| red dot | Interrupted | The turn was cancelled |
| gray dot | Idle | Quiet for about 30 minutes without reporting that it finished, or nothing is known about it |
| nothing | - | A plain shell, not an agent from Settings → AI Providers |

The state that is blocking *you* differs in shape, not only in hue: a `?` reads before its
color does, and working is a spinner rather than a dot. Every color sits behind a custom
property a theme can override (`--agent-monitor-working`, `-waiting`, `-done`,
`-interrupted`, `-idle`); the defaults are Orca's. Reduced motion shows the spinner as a
complete, still ring.

"Which of my agents needs me?" at a glance, without opening every tab — built assuming
one window per tab, so a window's mark always reflects a single pane.

## The AGENTS board

The same states, for every agent at once, in the editor area: an **Agents** tab that lays
every agent window out as a kanban board. Two ways in:

- **Agent Board: Open** in the command palette (`Ctrl+Shift+Alt+A` by default, rebindable
  in Keyboard Shortcuts).
- The robot icon in the status bar, which turns amber while an agent is waiting on you.
  Hovering it says how many are waiting and how many are working.

Opening it again focuses the tab already there.

- **Columns.** *Group by: Status* draws Working, Waiting on you, Done and Idle, always all
  four so the board keeps its shape; an interrupted turn is a red card in Done.
  *Group by: Project* draws one column per project instead, each card carrying its own mark.
- **Scope.** *This project* shows only the project of the tab you came from, and names it.
  *All projects* shows everything. *Selected* shows the projects you tick in its list,
  which always includes a ticked project that has no agent right now, so a selection is
  never dropped behind your back.
- **A project is the repository.** A window in a linked worktree belongs to its
  repository's project and shows its branch on the card, highlighted; a folder outside
  any repository is its own project.
- **Cards.** Each shows the agent, its project and branch, what it is on (why it is
  waiting, else the tool in flight and the prompt that started the turn), how long ago it
  last did anything, and which session and window it is. Click a card, or press Enter on
  it, to open that agent's terminal. Right-click (or the menu key, or a long press on a
  phone) for Open Terminal, Copy Folder Path, Copy Prompt and Kill Session, which asks
  first because it closes every window in the session.
- **Your own order.** Drag a card up or down its column to put it where you want it - with
  a mouse from anywhere on the card, with a finger from its grip. A card never moves
  between columns: its column is what the agent is doing, not something a drop can change.
  New agents slot in below the ones you placed, and **Reset Order** forgets the placement.
- **Only while you look.** The board refreshes only while its tab is on screen, and stops
  completely in the background.

Scope, the ticked projects, the grouping and the card order are remembered per browser,
not synced: they are how you like to look at the board, not settings.

## How it works

A server-side poll reads the app's own session list and classifies every window running one of the
agents in **Settings → AI Providers** (the app's own list, shared by every extension that
needs to know what an agent is). A window counts when its foreground command is the agent's
program or a process under it is, so a CLI that is really a script is found too: an
npm-installed `codex` runs as `node .../bin/codex`, and its window only ever reports `node`.
Each one is classified in priority order:

1. **An agent hook event** (see below) for that pane - the authoritative signal
   while it is fresh, and the rules are Orca's, read from its source. A turn
   starting or a tool running means working; a permission prompt, or the agent
   asking *you* a question (Claude's `AskUserQuestion`, Codex's
   `request_user_input`), means waiting; a turn ending means done, and a session
   starting lands as done too, because a resumed session sits at an idle prompt
   and "working" would spin over it forever. The prompt that started the turn and
   the tool in flight ride along, so the tooltip says *what* the agent is doing.
   A session starting mid-turn to compact its context is ignored, so it cannot end
   the turn. A record goes stale after 30 minutes with no event - the pane whose
   process died without a final hook - and the signals below take over; a stale
   record that said the turn finished stays **done**, anything else becomes **idle**
   once the transcript is quiet too. Events are keyed
   by the window they fired in, so two agent windows sharing one folder can't
   cross-contaminate each other's state, and an agent that sends no session id of
   its own is served exactly as well as Claude Code.
2. **The window's title**, when the backend supplies one. Claude Code sets an OSC title
   of `<glyph> <task>`. A rotating quarter-circle glyph (◐◑◓◒) means working. `✳` does
   **not** mean idle — it's Claude's own mark, present while it works as well — so it
   yields the task label only and the state falls through. Any other title shape is no
   signal, never guessed as a state. The app's window records carry no title today, on
   the bundled daemon or the tmux backend, so this step is dormant and the state comes
   from the hooks above or the transcript below.
3. **Transcript recency**, for the Claude Code session running in that window (from
   `~/.claude/sessions/`), or else the cwd's most recently written transcript
   — written within `agentMonitor.waitingThresholdSeconds` (default 45) means working,
   otherwise done, and idle once it has been quiet for 30 minutes. Not waiting: without
   a hook a permission prompt and a finished turn look the same, and the `?` would sit on
   every quiet agent. Only a Claude Code window reads a transcript: a Codex window in the same
   folder would otherwise borrow a Claude session's timing. No transcript at all (a non-Claude
   agent with no hooks) means idle. The mtime is read fresh on every poll; only the choice of
   *which* file to watch is cached, since a stale mtime here is a wrong state, not a
   slightly old one. The threshold is a timeout standing in for knowledge: one tool
   call routinely runs longer than a few seconds writing nothing, which is what the
   hooks above remove the need to guess about.

Nothing is ever typed into a window — every signal here is read-only. The extension
works on the bundled terminal daemon and on the tmux Terminal Backend alike; it never
runs `tmux` itself.

## Settings

| Key | Default | Description |
|---|---|---|
| `agentMonitor.waitingThresholdSeconds` | `45` | How long a transcript can go unwritten before a pane with no hooks stops showing as working |
| `agentMonitor.board.defaultScope` | `all` | The scope the AGENTS board opens with in a browser that has never picked one: `current`, `all` or `selected` |
| `agentMonitor.board.pollInterval` | `5000` | How often (ms) the AGENTS board refreshes while its tab is on screen |

Which programs count as an agent is no longer a setting here. **Settings → AI
Providers** holds the one list, and this extension reads it. The old
`agentMonitor.programs` key is gone rather than deprecated, so a value you had
set is not carried over - add the program to Settings → AI Providers instead.

## Agent hooks (optional, but recommended)

**This version moves hooks into the app itself.** They are no longer this extension's
business: **Settings → AI Providers** has one **Agent status hooks** switch that installs
them into every agent's own config file (and keeps them in step while it is on), plus
a snippet per agent to copy or install on a press - with a timestamped backup
first, touching only its own entries, and never a hook you wrote by hand. It also shows
which extensions asked for what.

What you get once the app's hooks are installed, beyond what this extension could do
before:

- **Any agent's hooks can reach it now, not just Claude Code's.** The old hook keyed on
  Claude's own `session_id`, which only Claude Code sends, so nothing else could ever
  report a state; the app's pipeline keys on the window, which every agent's hook
  can supply. Codex's hook events are **verified to fire** (codex-cli 0.146.1,
  2026-09-11) - but only once the app has written the trust entries Codex requires in
  `~/.codex/config.toml`, which Settings → AI Providers does for you. Without them Codex
  silently runs no hook at all, so a Codex pane with hooks "installed" by hand and no
  trust block shows nothing.
- **Any other agent gets whatever its own CLI sends.** The app ships no agents itself;
  they come from extensions, and the bundled Agents extension supplies Claude Code and
  Codex. An agent added by another extension is detected and hooked the same way, with
  no change here - this extension never names a CLI. Antigravity is the worked example
  in the app's extension docs: its CLI sends turn-start and turn-end but has no
  permission event at all (verified by firing hooks, not by reading its docs), so a
  permission prompt in an agy pane is invisible to any tool, this one included.
- **One hook per event, not one per extension**, and no auth hole: the app's endpoint
  is loopback-only with its own header check, where this extension's old route relied
  on a request with no `Origin` passing the gate.

Per-tool-call events (`tool call start`) are behind the **Also hook every tool call** toggle
in Settings → AI Providers, off by default - they fire once per tool call. With it off, this extension falls
back to transcript timing for "working", exactly as it does when no hooks are
installed at all.
