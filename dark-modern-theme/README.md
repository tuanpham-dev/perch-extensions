# Dark Modern

VS Code's **Dark Modern** color theme, flattened into a single perch-compatible theme file.

## Contributes

- **Color theme:** Dark Modern

## Source

Flattened from `microsoft/vscode`'s `theme-defaults` extension (`dark_modern.json` → `dark_plus.json` → `dark_vs.json` include chain), with the default `terminal.ansi*` palette and `editor.selectionBackground` injected — see `themes/dark-modern-color-theme.json` for the provenance comment. MIT-licensed; see `LICENSE.txt`.

## Install

In Perch, open the **Extensions** sidebar tab (`Ctrl+Shift+X`), find Dark Modern under **Available**, and click **Install**. Perch lists this repo's published catalog by default, so no registry setup is needed.

**From source:** run `npm install && npm run pack` in this repo, then either add its `dist/` folder as a source (gear icon, "Manage registries") and install from **Available**, or click "Install from .perch" and pick `dist/dark-modern-theme-<version>.perch`.
