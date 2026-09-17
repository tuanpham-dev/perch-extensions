# Claude Viewer

A Claude Code terminal session as rich chat you can drive from the web. Open it from the chat icon on any window running `claude` (in the PROJECTS pane, or the tab bar of that window's terminal). The terminal keeps running Claude as before; this tab reads it and types into it.

## What it shows

- **The conversation**, from Claude Code's own transcript: markdown with syntax-highlighted code (colored by your Perch theme's own token colors, so it matches the editor under Plastic, GitHub or any other theme), collapsible thinking, slash commands and their output, and a divider where the context was compacted.
- **Tool calls** as cards with a preview of what the terminal would show: a highlighted diff for Edit and Write, output lines for Bash, a count for Read, matches for Grep and Glob, the latest steps of a running subagent, and a thumbnail for screenshots and images. Expand a card for its full input and result.
- **Images** open full screen. Step through every image in the conversation with the arrows, the arrow keys or a swipe; zoom with the wheel, a pinch, a double-click or double-tap on the image, or the + and - buttons; drag to pan a zoomed image. It closes from a click on the dark area around the image, the × button, or Esc.
- **The toolbar**: the permission mode (click to cycle, like Shift+Tab), what Claude is doing right now (with elapsed time and tokens), the model in use (updated right after a `/model` switch), the context used by the last turn, and an estimated cost at API rates. The terminal button in the tab bar opens the window's own terminal tab. The 5-hour and 7-day plan meters are there too if you turn them on.

## What you can do without switching to the terminal

- **Answer prompts** with a click, with the options the terminal offers:
  - tool permissions (Bash, Write, Edit, and the rest)
  - plan approval, including "Tell Claude what to change" with a text field
  - the folder trust prompt
  - AskUserQuestion, with tabs, checkboxes, free-text answers and the review screen
  - numbered pickers such as `/model`, with a button for each key the picker's footer offers for a row (on `/model`, "Use this session only")
- **Send messages**: several lines at once, `/` for commands and skills, `@` for files in the project, and files pasted, attached or dropped anywhere on the tab (images show as thumbnails; other files are uploaded and their path added to the message). Anything already typed in the terminal's input box shows as the composer's placeholder while it is empty; press Tab or the **Use** button to take it into your message. While Claude is working and the composer is empty, its button is **Stop**, which interrupts the turn like Esc.
- **Anything else** the terminal shows that has no buttons here, such as `/config`, opens the **Terminal screen** strip by itself: the bottom lines of the terminal with a keypad (arrows, Enter, Esc, Tab, Shift+Tab, Backspace, Ctrl+C and digits).

Every click that answers a prompt is checked against a fresh read of the terminal first. If the terminal has moved on (you answered it there, or Claude cancelled it), nothing is sent and the card updates.

## When Claude is waiting

- The tab's title gets a dot.
- The chat icon on the window's row turns into a bell.
- A push notification goes to every browser subscribed to notifications in Settings (turn off with **Push notifications**).

This works with no tab open: the server watches every Claude window.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Poll interval | 1000 ms | How often each Claude window's screen is read, and how often an open tab reads new transcript lines. |
| Font size | 14 px | Text size of the conversation. |
| Enter key | Send the message | Or "Start a new line", where Ctrl+Enter (Cmd+Enter on a Mac) sends. Applies to messages and to answers typed in a prompt. |
| Show context | on | The context used by the last turn and the estimated cost, in the toolbar. |
| Show usage meters | off | The 5-hour and 7-day plan meters in the toolbar. Agent Usage Monitor already shows them in the status bar. |
| Push notifications | on | A push when Claude starts waiting on a prompt. |
| Screen strip lines | 12 | How many terminal lines the Terminal screen strip shows. |

With the app's agent hooks installed (Settings → AI Providers), a prompt shows within a fraction of a second of appearing. Without them it shows within one poll interval.

## Requirements

- A Perch version whose server gives extensions `host.sessions.capture` and `host.notifications.push`. On an older Perch the conversation still shows, but prompts, the mode and the activity line do not.
- Claude Code in a terminal window of the app, on the bundled terminal daemon or the tmux backend (tmux-engine 1.0.1 or later).

## Limits

- Prompts are read from the terminal's screen. The layouts were checked against Claude Code 2.1.273. A future redesign may stop a prompt from being recognized; it then shows in the Terminal screen strip, which always works.
- The cost is an estimate at Anthropic API rates. A subscription plan is not billed per token.
- Text Claude is still writing appears when Claude Code writes it to the transcript, one block at a time, not token by token.
