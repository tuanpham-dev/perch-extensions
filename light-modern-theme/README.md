# Light Modern

VS Code's **Light Modern** color theme, flattened into a single perch-compatible theme file.

## Contributes

- **Color theme:** Light Modern

## Source

Flattened from `microsoft/vscode`'s `theme-defaults` extension (`light_modern.json` → `light_plus.json` → `light_vs.json` include chain), with the default `terminal.ansi*` palette and `editor.selectionBackground` injected — see `themes/light-modern-color-theme.json` for the provenance comment. MIT-licensed; see `LICENSE.txt`.

## Install

In Perch, open the **Extensions** sidebar tab (`Ctrl+Shift+X`), find Light Modern under **Available**, and click **Install**. Perch lists this repo's published catalog by default, so no registry setup is needed.

**From source:** run `npm install && npm run pack` in this repo, then either add its `dist/` folder as a source (gear icon, "Manage registries") and install from **Available**, or click "Install from .perch" and pick `dist/light-modern-theme-<version>.perch`.
