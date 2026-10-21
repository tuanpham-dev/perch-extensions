# Automations

Agent work that starts itself. An **AUTOMATIONS** section in the **Run** tab lists automations -
a trigger and an action each - and the server runs them with no browser open.

## Triggers

| Trigger | Runs |
| --- | --- |
| Every day at a time | Daily at `HH:MM`, server-local time. |
| Every few minutes | Every `n` minutes, counted from the last run. |
| Cron | A standard 5-field expression (`minute hour day-of-month month day-of-week`): numbers, `*`, ranges, `*/n` steps and comma lists. Day of week 0-7, with 0 and 7 both Sunday. An expression that can never run is refused. |
| When something happens in Agent Tasks | `task-completed`, `task-failed`, `task-blocked`, `gate-opened` or `worker-lost`, optionally only for one run id or one repository. |

Schedules are checked every 15 seconds, so a run can start up to 15 seconds late. Event
triggers fire as the event happens.

**Missed runs.** If the server was down when a schedule came due, it runs once at startup when
it was due within `automations.missedRunGraceMinutes`; an older miss is skipped, recorded as
`missed`, and rescheduled. Turning an automation back on, or changing its trigger, counts from
that moment.

## Actions

| Action | Does |
| --- | --- |
| Ask the AI and keep the answer | Sends the prompt to the AI chosen in `automations.aiProfile` (or your default in **Settings → AI Providers**), with the model in `automations.aiModel` when one is set, running in the repository when one is set. It may take up to 10 minutes. The reply becomes the automation's last result. |
| Create an Agent Tasks task | Creates a run and a task in [Agent Tasks](../agent-tasks/README.md), with the prompt as the task spec. |
| Create a task and start a worker on it | The same, then starts a worker with the chosen agent, in a new worktree or in the repository. |

An event-triggered action gets the event appended to its prompt: the event, the task and its
id, the run and the repository.

An automation that is still running is not started again on top of itself.

**No loops.** Automations remembers every task it creates: which automation made it, and how deep
in a chain it is. A task's events never start the automation that created it, so an automation
on "a task fails" that creates a task that fails runs once. Automations that set each other off
stop after three hops: the run that would be the fourth is recorded as `stopped` with the note
"stopped: chain depth 3 reached" instead of running.

**Pause All.** The pause button in the panel's header stops every schedule and every Agent Tasks
event from starting anything until you resume, and stays on across restarts. A schedule that comes
due while paused is passed over, not saved up for when you resume. **Run now** is turned off too.

## The panel

Each row shows the name, the trigger, the next run, the last result (click to expand it, along
with the 19 runs before it), an enable checkbox, **Run now**, Edit and Delete. The + in the header creates one. Rows that need
Agent Tasks say **Requires the Agent Tasks extension** while its socket cannot be reached.

## Agent Tasks

Automations talks to Agent Tasks through its control socket, in the runtime folder Perch gives
Agent Tasks (by default `~/.local/state/perch/x/perch.agent-tasks/control.sock`), never by
importing it. Perch reports that folder, so each Perch profile reaches its own Agent Tasks:

- scheduled "ask the AI" automations need nothing else;
- the two task actions record `Agent Tasks is not installed` as their result when the socket is
  not there;
- event triggers hold the socket's `subscribe` stream open and reconnect on their own, backing
  off from 1 second to at most 60, so installing or restarting Agent Tasks needs no restart here.

A worker an automation starts finishes the way any Agent Tasks worker does: through the agent's
hooks (installed from **Settings → AI Providers**), the `agent-task done` command, or the
liveness sweep - see the Agent Tasks README for the worker contract and the full CLI.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `automations.missedRunGraceMinutes` | `60` (0-1440) | How late a missed scheduled run may still fire at startup. 0 fires nothing missed. |
| `automations.aiProfile` | default AI | Which AI answers "ask the AI" automations. |
| `automations.aiModel` | that AI's model | Which model it uses. |

## Files

Every automation, with its last 20 runs and their results, and its next run, is kept in Perch's extension storage: a
private database under Perch's config folder (`~/.config/perch/extension-data/perch.automations`
by default, or under `PERCH_CONFIG_DIR`). The Automations panel updates as soon as anything
changes, including a run starting or finishing and Agent Tasks appearing or going away, with no
polling. Uninstalling Automations keeps them; **Settings → Extensions → Stored
data** deletes them.

Needs Perch 0.9 or newer. Version 1.1 starts empty: automations saved by earlier versions (in
`automations/automations.json` under Perch's config folder) aren't carried over, and that file is
left as it was.
