# Perch extensions

Optional [Perch](https://github.com/tuanpham-dev/perch) extensions, packaged as installable `.perch` files and served as a registry catalog. These are not bundled with Perch itself — install the ones you want through the app's Extensions sidebar tab.

## Extensions

| Extension | Type | Source | License |
|---|---|---|---|
| Agent Usage Monitor | a status-bar item per coding agent: limit meters with reset times, token blocks per window with burn rate, and real spend where the agent reports it (Claude Code today and 7 days; Codex reports no cost), plus an item showing the model running in the active terminal | first-party (Perch) | MIT |
| System Stats | memory in use in the status bar; its popover shows a 2-minute CPU chart plus memory, swap, disk and network usage | first-party (Perch) | MIT |
| Claude Viewer | a Claude Code terminal session as rich chat you can drive from the web: highlighted code, tool cards with diffs and screenshots, and every prompt the terminal asks (permissions, plan approval, folder trust, questions, pickers) answered with a click; mode, activity, context and cost in the toolbar, a bell and a push notification while Claude waits, and a terminal screen strip with a keypad for anything else | first-party (Perch) | MIT |
| Agent Monitor | classifies every terminal window running an agent as working/waiting/done and shows it as a status dot on that window's own PROJECTS-pane row; reads the agent list from Settings → AI Providers and takes its hook events from the app's own pipeline, so every agent in that list gets states, not just Claude Code | first-party (Perch) | MIT |
| Agent Tasks | an AGENT TASKS sidebar tab that orchestrates several agents: runs of dependency-ordered tasks, each worked by a supervised agent in its own session and worktree, with a coordinator inbox, decision gates and an `agent-task` CLI workers report through; completion comes from the agent's hooks, the CLI or a liveness sweep | first-party (Perch) | MIT |
| Automations | an AUTOMATIONS section in the Run tab: ask the AI, create an Agent Tasks task or start a worker on a daily, interval or cron schedule, or when an Agent Tasks task completes, fails, blocks, opens a gate or loses its worker; runs on the server with no browser open | first-party (Perch) | MIT |
| Custom Sidebar Tabs | your own sidebar tabs, each with a name and an icon, that you fill by dragging panes into them; create, rename, re-icon or delete them from the tab strip's right-click menu, the command palette or Settings; deleting a tab sends its panes back where they came from, and disabling the extension keeps where they were | first-party (Perch) | MIT |
| Ghostty Terminal Engine | the ghostty-web (WASM) terminal renderer as a **Ghostty** option under Settings → Terminal; without it Perch uses its bundled xterm.js engine | first-party (Perch) | MIT |
| tmux Terminal Backend | runs the app's terminals in tmux instead of the bundled daemon (Settings → Terminal Backend), so sessions started with tmux anywhere show up in the app; one app window per tmux pane, history replayed through control mode, windows sized for the view used last; needs tmux 3.2+ | first-party (Perch) | MIT |
| Text Editor | Monaco (the VS Code editor, lazy-loaded), selectable in Settings → Editor as what opens files, git diffs and merge conflicts — real TextMate highlighting matching VS Code/code-server, TS/JS/JSON/CSS/HTML IntelliSense, inline conflict resolution, optional vim keybindings, and save-back to disk | first-party (Perch) | MIT |
| Git History | Git: File History and Git: Blame on any tracked file, from the FILES tree menu: history follows renames and opens a file's diff at any commit through your configured editor, blame shows who last touched each line; read-only | first-party (Perch) | MIT |
| GitHub | GITHUB sidebar tab: open PRs/issues for the active repo, with "Start work" creating a worktree session (optionally priming an agent) | first-party (Perch) | MIT |
| Jira | JIRA sidebar tab: issues assigned to you and the active repo's project, with "Start work" creating a worktree session (optionally priming an agent and moving the issue to In Progress) | first-party (Perch) | MIT |
| AI Command Search | natural language → shell command via the AI configured in Settings → AI Providers | first-party (Perch) | MIT |
| Prompts | `.prompt.md` editor tab with AI refine + AI-suggested filenames | first-party (Perch) | MIT |
| Full Keyboard | on-screen keyboard | first-party (Perch) | MIT |
| One-Hand Operation | bottom gesture bar (swipe, double tap, long press) | first-party (Perch) | MIT |
| GUI Apps | run Linux GUI apps on the server, viewed/controlled in the browser via xpra (adaptive HTML5 remote display) | first-party (Perch) | MIT |
| Dark Modern | color theme (with full `tokenColors`) | flattened from [microsoft/vscode](https://github.com/microsoft/vscode)'s `dark_modern.json` include chain | MIT |
| Light Modern | color theme (with full `tokenColors`) | flattened from [microsoft/vscode](https://github.com/microsoft/vscode)'s `light_modern.json` include chain | MIT |
| GitHub Theme | color theme (9 variants: light, dark, dimmed, high contrast, colorblind) | [primer/github-vscode-theme](https://github.com/primer/github-vscode-theme) | MIT |
| One Dark Pro | color theme (5 variants) | [Binaryify/OneDark-Pro](https://github.com/Binaryify/OneDark-Pro) | MIT |
| VSCode Icons | file icon theme | [vscode-icons/vscode-icons](https://github.com/vscode-icons/vscode-icons) | MIT |
| Popular Monospace Fonts | terminal fonts (4 groups) | Fira Code, JetBrains Mono, Cascadia Code, Source Code Pro — via [Fontsource](https://fontsource.org/) | OFL-1.1 |
| Symbols Nerd Font | icon glyphs (powerline, Font Awesome, Devicons, …) as a **secondary** font | [ryanoasis/nerd-fonts](https://github.com/ryanoasis/nerd-fonts) | MIT |

Each extension's `LICENSE.txt` carries the full upstream license text and attribution.

### Dark Modern / Light Modern

VS Code's own theme loader chains `dark_modern.json → dark_plus.json → dark_vs.json` (same for light). Perch's theme loader only follows one `include` level, and the `*_plus.json` layer contributes no workbench colors anyway (only `tokenColors`, which Perch ignores) — so these two themes are authored as single flattened JSON files merging the `*_vs.json` + `*_modern.json` color layers.

A handful of keys VS Code sets via `registerColor()` defaults in its own source rather than in any theme JSON — the 16 `terminal.ansi*` colors, `editor.selectionBackground`, `gitDecoration.*`, `charts.yellow`/`charts.green`, `editorWarning.foreground` — are injected from those same registry defaults so the themes render a complete, self-contained palette. See the provenance comment at the top of each theme JSON for the full list and source.

### Popular Monospace Fonts

One extension, four selectable font groups (Fira Code, JetBrains Mono, Cascadia Code, Source Code Pro), each with core latin + latin-ext coverage across regular/500/bold weights plus italic where the upstream family ships one — sourced from the already-split, already-subsetted [`@fontsource`](https://fontsource.org/) npm packages rather than raw upstream releases, same approach as Perch's own bundled `ibm-plex-mono` extension.

### Symbols Nerd Font

A companion, not a replacement: the symbols-only Nerd Font face (10,413 icon glyphs, no letters or digits), meant for the **Secondary font** slot in Settings → Terminal so it backs whichever font you actually type in. Perch used to bundle this face until it was removed from the default font stack, which is where the tofu boxes in starship / powerlevel10k prompts and `eza` listings came from; installing this puts the glyphs back for any primary font, including core's own IBM Plex Mono.

The woff2 is converted without subsetting from that exact removed file — see the extension's `README.md` for the regeneration command.

## Packing

```sh
npm install   # first time only — pulls esbuild for code extensions
npm run pack
```

`pack` first runs `npm run build`, which esbuild-bundles any **code** extension (a folder with `src/client.tsx` — e.g. Full Keyboard) into its `dist/client.js`/`client.css`, with `react`/`@perch/engine-support` aliased to the host-instance shims in `scripts/shims/`. Data-only extensions (themes, fonts, icons) have no build step. Then, per extension, it produces: `dist/<extension>-<version>.perch` (a zip with contents under a top-level `extension/` folder, matching the format Perch's extension installer expects), a `-README.md` copy, and a `-icon.<ext>` copy for any extension with an `icon` manifest field — plus a `dist/index.json` catalog listing all of the above, in the shape Perch's registry feature expects.

## Registry (recommended)

Perch already knows this registry: its built-in default is this repo's GitHub Pages catalog (see [Hosting the registry on GitHub Pages](#hosting-the-registry-on-github-pages)). Open the **Extensions** sidebar tab (`Ctrl+Shift+X`), find the extension under **Available**, and click Install.

### A local build as a source

`dist/` is itself a valid registry source — no separate publishing step needed, which is handy while developing an extension. In Perch:

1. Open the **Extensions** sidebar tab (`Ctrl+Shift+X`).
2. Click the gear icon → "Manage registries".
3. Add this repo's absolute `dist/` path (e.g. `/works/perch-extensions/dist`) as a source, or serve it over HTTP (`python3 -m http.server` from inside `dist/`) and add that URL instead.
4. Every extension in the table above appears under **Available** — click Install.

Re-running `npm run pack` after editing a theme/font and clicking the refresh icon in the Extensions tab picks up the change immediately, without reinstalling.

## Hosting the registry on GitHub Pages

For a shareable, always-online registry, this repo publishes `dist/` to GitHub Pages via [`.github/workflows/pages.yml`](.github/workflows/pages.yml). The workflow runs `npm run pack` and deploys the built catalog on every push to `main` — `dist/` is never committed (it's `.gitignore`d); it's regenerated in CI.

Perch fetches the catalog server-side, so no CORS config is needed. This URL is Perch's built-in default registry, so once Pages is live every Perch install lists these extensions without adding a source (the server's `EXTENSION_REGISTRY` env var overrides it, or disables it when set empty):

```
https://tuanpham-dev.github.io/perch-extensions/
```

The server appends `index.json` to that base, then downloads each `.perch`/README/icon by the relative path in the catalog.

### One-time setup

```sh
# from inside this repo, with the GitHub CLI authenticated (gh auth login)
git remote add origin git@github.com:tuanpham-dev/perch-extensions.git
gh repo create tuanpham-dev/perch-extensions --public --source=. --remote=origin --push
```

Then enable Pages with the **GitHub Actions** source (once):

```sh
gh api -X POST repos/tuanpham-dev/perch-extensions/pages \
  -f 'build_type=workflow'
```

Or via the web UI: **Settings → Pages → Build and deployment → Source: GitHub Actions**. After the first workflow run finishes (Actions tab), the URL above is live. Publishing a new extension version is just `git push` — bump the version, push, wait for the Action, then hit refresh in the Extensions tab (allow a few minutes for GitHub's CDN cache).

## Installing manually

Without setting up a registry source, install one `.perch` at a time: in the Extensions tab, click "Install from .perch" and pick a file from `dist/`. Or via the API — the endpoint expects the raw file bytes as the request body, not a multipart upload:

```sh
curl -X POST -H "content-type: application/octet-stream" \
  --data-binary @dist/vscode-icons-12.19.0.perch \
  http://localhost:<port>/api/extensions/install
```
