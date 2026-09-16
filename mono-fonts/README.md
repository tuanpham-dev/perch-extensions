# Popular Monospace Fonts

Four popular terminal/coding monospace fonts, each in regular, medium, and bold weights (plus italic where the upstream family ships one): **Fira Code**, **JetBrains Mono**, **Cascadia Code**, and **Source Code Pro**.

## Contributes

- **Font groups:** Fira Code, JetBrains Mono, Cascadia Code, Source Code Pro

Each group covers core latin + latin-ext character coverage, split into per-script `unicode-range` subsets so the browser only fetches the glyphs it actually needs.

## Source

OFL-1.1 licensed; see `LICENSE.txt` for the per-family copyright notices and license text.

## Install

In Perch, open the **Extensions** sidebar tab (`Ctrl+Shift+X`), find Popular Monospace Fonts under **Available**, and click **Install**. Perch lists this repo's published catalog by default, so no registry setup is needed.

**From source:** run `npm install && npm run pack` in this repo, then either add its `dist/` folder as a source (gear icon, "Manage registries") and install from **Available**, or click "Install from .perch" and pick `dist/mono-fonts-<version>.perch`.

Then pick a font group from Settings → Terminal.
