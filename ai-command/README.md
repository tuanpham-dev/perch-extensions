# AI Command Search

Natural language → shell command, powered by the AI configured in Settings → AI Providers. The generated command is typed at your prompt for review — it is **never executed automatically**.

## Usage

- **Command palette** (`Ctrl+Shift+P`) → "AI: Generate Command…", describe what you want, press Enter.
- **Quick switcher** (`Ctrl+P`) → type `??` followed by your request (e.g. `??list the 5 largest files here`) and press Enter on the "Ask AI" row.

Either way the reply lands on your command line in the active terminal, ready to edit or run yourself.

The text is inserted through the app's own session API, so it works on the bundled terminal daemon and on the tmux Terminal Backend alike.

## Which AI

Providers are set up once in **Settings → AI Providers**, shared with every other AI feature in the app - an installed agent's CLI (Claude Code and Codex come with the bundled agents), the Anthropic or OpenAI HTTP APIs, or a custom command. By default this extension uses the app's default AI; its own settings can point it at a different configured AI (`aiCommand.aiProfile`) and model (`aiCommand.aiModel`).

A CLI provider must be installed and authenticated on the **server** machine — it runs there, not in the browser. Expect a few seconds of startup latency per request; a small, fast model helps.
