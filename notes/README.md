# Notes

Sticky notes in Markdown, on a project, a terminal or a file.

## Using it

The **NOTES** section in the Explorer lists the notes on the terminal you're in, the way a menu would:

- **This terminal**, **This project** and **Files in this project**, one row per note: its colour, its title, and a check while its card shows. Click a row to hide or show its card. Each row has a **Delete** button, and a file note's row also has an **Open** button for that file's preview.
- Right-click a row (or press `Shift+F10`) for **Hide Card** / **Show Card**, **Edit** (opens the card ready for typing), **Open File**, the colours and **Delete…**.
- The eye in the section's header offers **Hide Cards on This Terminal** (or **Show Cards…**) and **Show All**.
- **+** in the section's header adds a note to this terminal or to the whole project; its card opens ready for typing. To note a file, use **Add Note** in the file's right-click menu in FILES, or **+** on its preview.
- **Detached**: notes whose terminal was closed or whose file is gone, with **Reattach…** (pick another terminal or file) and **Delete**.

A note is read and edited on its card. On a phone, where cards aren't drawn, tapping a row opens the note in the list instead.

## Floating cards

A terminal's notes also float over that terminal as sticky cards. Project notes and file notes float over every terminal of the project, and a file's notes also float over that file's preview tabs (Markdown, JSON, CSV, images, PDFs, HTTP Client and other viewers). A file note's header shows the file's path in the project, with an **Open file** button that opens its preview:

- Drag a card by its header, and resize it from its bottom-right corner. Its place and size are kept as a share of the terminal or preview, so they hold when you resize the window, and they're the same on every device.
- The header's buttons edit the note, change the card's colour (six colours, each readable in light and dark themes), open a menu (Edit, Show in NOTES, Delete…), open the file (file notes), and hide that card. Double-click the card's text, or press its edit button, to edit it in place; a single click selects text and follows links, opening them in a new browser tab; Shift+click opens a web link in Perch's web preview instead (Perch 0.9.4 or later, with the built-in browser from Ports). Right-click the text for Open Link, Open Link in Web Preview, Copy Link Address, Copy, Select All and the note's own actions; Shift+right-click gives the browser's own menu. `Esc` goes back to reading. In NOTES, double-click a note's preview to edit it.
- A chip in the corner (top right of a terminal, bottom right of a preview) shows **Notes N**, adds a note (on this terminal or on the whole project, or on the file), hides or shows all of them there, and offers **Show all** for cards hidden one by one. With no notes it's a single note button.
- On a phone, or in a small grid cell, cards aren't drawn: the chip shows the count and opens the NOTES section.

Hiding and showing are saved too, so they're the same in every browser.

## The status bar

The **Notes** item in the status bar shows how many notes are on the terminal you're in (`1/2` when some cards are hidden) and opens the same list as the NOTES section, with its checks, actions and add choices.

## Settings

- **Show the Notes chip** (`notes.showChip`, on by default): off removes the corner chip from terminals and previews; the cards still float, and the NOTES section and the status-bar item still show, hide and add them.
- **Show the status-bar item** (`notes.showStatusBar`, on by default), also switchable from the status bar's own right-click menu.

## Badges

A terminal with notes shows a note icon on its row in PROJECTS; click it to open that terminal and its notes. A file with notes shows the same icon in FILES; **Show Notes** in its right-click menu opens them.

Renaming or moving a file in Perch's FILES panel (rename, drag, cut and paste) carries its notes along. A file renamed some other way, such as `mv` in a terminal, can't be told apart from a deleted one, so its notes move to **Detached** until you reattach them.

Commands: **Notes: Add Note to Terminal**, **Notes: Add Note to Project**, **Notes: Show Notes**.

## Where notes are kept

On the Perch server, in Perch's extension storage: a private database under Perch's config folder (`~/.config/perch/extension-data/perch.notes` by default, or under `PERCH_CONFIG_DIR`). Never in a repository, so they don't show up in `git status`, and every browser and device connected to the same server sees the same notes. A note saved in one browser shows in every other within a second.

Terminal notes follow the terminal itself, so they survive server and terminal-daemon restarts. Uninstalling Notes keeps them; **Settings → Extensions → Stored data** deletes them.

Needs Perch 0.9 or newer.

Notes 1.3 starts empty: notes saved by earlier versions (in `notes/notes.json` under Perch's config folder) aren't carried over, and that file is left as it was.
