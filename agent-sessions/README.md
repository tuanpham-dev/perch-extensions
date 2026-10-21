# Agent Sessions

Every past conversation your coding agents had in a project, in one tab: search them, preview them, and pick any one back up in a new terminal.

## Opening it

- **Browse Agent Sessions…** in a project's tab group menu (the arrow on its chip).
- **Agent Sessions: Browse Agent Sessions…** in the command palette, for the project you're in.
- **Ctrl+P**: type part of a conversation's title, and pick the row tagged `session`.

## What it shows

One row per conversation, newest first, across the project's folder and all of its git worktrees: the agent, its title (the agent's own title or summary when it has one, otherwise the first prompt), when it was last active, how many messages it has, and the worktree's branch. A conversation running in a terminal right now is marked **Open**.

**This project | All projects** at the top switches between this project's conversations and every project Perch knows: the ones open in the sidebar plus your recent and pinned projects, each with its worktrees. In **All projects** each row starts with its project's name, search matches project names too, and the project menu beside the agent menu narrows the list to one or more projects (tick them; **All projects** clears it). Both choices are remembered.

Search narrows the list by title, and the agent menu narrows it to one agent. Select a row to preview its last 50 messages, with tool calls on one line each.

**Resume** opens a new terminal in the conversation's folder, named after it, and runs the agent's resume command there (`claude --resume <id>`, `codex resume <id>`), with its skip-permissions flag when **Agent permissions** is Yolo. That command is remembered by the terminal, so a restart reopens the same conversation. For a conversation that's already open, the button reads **Go to Window** and takes you there instead. Double-clicking a row does the same as the button.

The tab refreshes when you come back to it; the refresh button does it on demand.

## Which agents

Any agent whose definition says where it keeps its conversations. Claude Code and Codex come with Perch's bundled Agents extension. An extension that adds another agent can declare one of the formats Perch reads, or provide its own reader; see `contributes.agents` and **Session readers** in Perch's [extension API](https://github.com/tuanpham-dev/perch/blob/main/docs/EXTENSION_API.md).

Nothing here changes an agent's files: the tab only reads them.

Needs Perch 0.9 or newer.
