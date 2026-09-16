# Full Keyboard

A full on-screen **QWERTY keyboard** for mobile, for typing in a terminal from a phone or tablet. First-party (Perch), MIT-licensed.

## Contributes

- **Terminal accessory:** a docked or floating on-screen keyboard, shown for a focused terminal on mobile.
- **Settings component:** a drag-and-drop editor for the special-key top bar.

## What it does

- **QWERTY grid** with a number row, sticky one-shot **Shift / Ctrl / Alt**, two **symbol pages** (`!#1` ⇄ `1/2`/`2/2`), and **Backspace / arrow-key hold-to-repeat**. Every printable ASCII character is reachable.
- A **customizable special-key top bar** above the grid (Esc, Tab, arrows, Ctrl+C, voice input, image upload by default) — the same model as the Touch Keys bar, editable in settings.
- **Fixed** mode (docked below the terminal, which shrinks above it) or **Floating** mode (a draggable ⌨ toggle you tap to show the keyboard as an overlay that leaves the terminal full-size; the panel opens above or below the toggle depending on where you drag it). A third style keeps the floating toggle but has it show and hide the docked keyboard instead.
- Optionally **hides the device's native keyboard** while shown (never / while showing / always — configurable), so the two don't stack.

## Settings

- `fullKeyboard.show` — when the keyboard shows (auto = mobile only / always / never).
- `fullKeyboard.style` — fixed (docked), floating (movable toggle, overlay keyboard) or floating-docked (movable toggle, docked keyboard).
- `fullKeyboard.suppressSoftKeyboard` — when to hide the OS keyboard (never / whenShown / always).
- `fullKeyboard.topKeys` — the top-bar layout (edited with the drag-and-drop editor in settings).

## Install

In Perch, open the **Extensions** sidebar tab (`Ctrl+Shift+X`), find Full Keyboard under **Available**, and click **Install**. Perch lists this repo's published catalog by default, so no registry setup is needed.

**From source:** run `npm install && npm run pack` in this repo, then either add its `dist/` folder as a source (gear icon, "Manage registries") and install from **Available**, or click "Install from .perch" and pick `dist/full-keyboard-<version>.perch`.
