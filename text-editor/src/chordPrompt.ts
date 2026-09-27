// The "vim or editor?" question for a Ctrl chord that means different things
// to each, asked the first time the chord is pressed with vim on.
//
// Drawn as a bar directly above the vim status line rather than through the
// host: the extension API has no notification surface, and the status line is
// where a vim user is already looking for what the last key did. It is plain
// DOM, owned by vim.ts next to the status node monaco-vim also draws into, so
// the file editor, the merge view and a diff's editable side all get it
// without each view rendering it.
import type { CodeEditor } from "./monacoNs";
import type { ChordOwner } from "./settings";

/**
 * What each side does with a chord: the prompt's two button labels, plus the
 * editor's meaning as something that can be run after the fact. The keypress
 * that raised the prompt is swallowed, so once the user answers, the chosen
 * side's action is run for them, as if the key had gone there all along.
 */
interface ChordMeanings {
  vim: string;
  editor: string;
  /**
   * Performs the editor meaning in `editor`. Resolves false when it couldn't,
   * which only happens for paste: reading the clipboard needs the async
   * clipboard API (HTTPS or localhost) and the browser's permission, while a
   * real Ctrl+V needs neither.
   */
  runInEditor(editor: CodeEditor): boolean | Promise<boolean>;
}

/** Runs one of Monaco's registered editor actions by id. */
function runAction(id: string) {
  return (editor: CodeEditor) => {
    const action = editor.getAction(id);
    if (!action) return false;
    void action.run();
    return true;
  };
}

/**
 * Copy and cut go through execCommand rather than Monaco's clipboard actions,
 * which are commands its keybinding service dispatches, not editor actions a
 * caller can run. With focus in the editor's textarea, execCommand fires the
 * same native copy/cut event a real Ctrl+C does, so Monaco's own handler fills
 * the clipboard (including its whole-line copy of an empty selection). It is
 * allowed here because the prompt's button click counts as a user gesture.
 */
function execClipboard(command: "copy" | "cut") {
  return (editor: CodeEditor) => {
    editor.focus();
    return editor.getContainerDomNode().ownerDocument.execCommand(command);
  };
}

async function pasteFromClipboard(editor: CodeEditor): Promise<boolean> {
  try {
    const text = await navigator.clipboard?.readText();
    if (typeof text !== "string") return false;
    editor.focus();
    // Monaco's own paste handler, the same one a real paste event ends in, so
    // undo and multi-cursor distribution behave as they do for Ctrl+V.
    editor.trigger("keyboard", "paste", { text });
    return true;
  } catch {
    // Permission denied, or no clipboard API on a plain-HTTP origin.
    return false;
  }
}

/**
 * The chords worth asking about: each is bound by vim and also has a common
 * editor meaning, so either answer is a real choice. Chords vim leaves alone
 * (Ctrl+Z) already reach the editor, and chords with no editor meaning
 * (Ctrl+R, Ctrl+O) have nothing to lose by staying with vim, so neither is
 * asked. Both lists in Settings still take any chord by hand.
 */
export const ASKED_CHORDS: ReadonlyMap<string, ChordMeanings> = new Map([
  [
    "Ctrl-a",
    {
      vim: "increment number",
      editor: "select all",
      runInEditor: (editor) => {
        const model = editor.getModel();
        if (!model) return false;
        editor.setSelection(model.getFullModelRange());
        return true;
      },
    },
  ],
  ["Ctrl-c", { vim: "cancel, leave insert mode", editor: "copy", runInEditor: execClipboard("copy") }],
  [
    "Ctrl-d",
    { vim: "scroll half page down", editor: "select next match", runInEditor: runAction("editor.action.addSelectionToNextFindMatch") },
  ],
  ["Ctrl-f", { vim: "page down", editor: "find", runInEditor: runAction("actions.find") }],
  ["Ctrl-u", { vim: "scroll half page up", editor: "undo cursor move", runInEditor: runAction("cursorUndo") }],
  ["Ctrl-v", { vim: "visual block", editor: "paste", runInEditor: pasteFromClipboard }],
  ["Ctrl-x", { vim: "decrement number", editor: "cut", runInEditor: execClipboard("cut") }],
  [
    "Ctrl-y",
    {
      vim: "scroll line up",
      editor: "redo",
      runInEditor: (editor) => {
        const model = editor.getModel();
        if (!model) return false;
        void model.redo();
        return true;
      },
    },
  ],
]);

/** `Ctrl-v` -> `Ctrl+V`, the way the rest of the app spells shortcuts. */
export function chordLabel(chord: string): string {
  return chord
    .split("-")
    .map((part, i, all) => (i === all.length - 1 ? part.toUpperCase() : part))
    .join("+");
}

export interface ChordPrompt {
  /**
   * Shows the question for `chord`, replacing whatever the bar showed.
   * `replay` performs the swallowed keypress on the chosen side once the user
   * answers, resolving false if it couldn't.
   */
  ask(chord: string, replay: (owner: ChordOwner) => boolean | Promise<boolean>): void;
  /** Hides the bar if it is asking about a chord that now has an owner. */
  refresh(isDecided: (chord: string) => boolean): void;
  dispose(): void;
}

/**
 * A prompt bar inserted just before `statusNode`. `onAnswer` records the
 * choice; `onDone` hands focus back to the editor, before the replay runs. The buttons never take
 * focus themselves (mousedown is cancelled), so answering leaves the cursor
 * where it was.
 */
export function createChordPrompt(
  statusNode: HTMLElement,
  onAnswer: (chord: string, owner: ChordOwner) => void,
  onDone: () => void,
): ChordPrompt {
  const bar = document.createElement("div");
  bar.className = "text-editor-vim-ask";
  bar.hidden = true;
  statusNode.parentElement?.insertBefore(bar, statusNode);

  let asking: string | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
  };

  const hide = () => {
    clearTimer();
    asking = null;
    bar.hidden = true;
    bar.replaceChildren();
  };

  const button = (text: string, className: string, onClick: () => void): HTMLButtonElement => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = className;
    el.textContent = text;
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", onClick);
    return el;
  };

  const confirm = (chord: string, owner: ChordOwner, replayed: boolean) => {
    // No longer a question, so the settings change this answer causes must
    // not hide the confirmation through refresh().
    asking = null;
    const meanings = ASKED_CHORDS.get(chord);
    const label = chordLabel(chord);
    const text = document.createElement("span");
    text.className = "text-editor-vim-ask-text";
    // When the swallowed key couldn't be performed for the user (a paste the
    // browser wouldn't allow), say so rather than leave them wondering where
    // it went.
    text.textContent =
      `${label} now ${owner === "vim" ? "goes to vim" : "goes to the editor"}` +
      `${meanings ? ` (${meanings[owner]})` : ""}.` +
      `${replayed ? "" : " Press it again to use it."}` +
      ` Change it any time in Settings > Text Editor.`;
    bar.replaceChildren(text);
    clearTimer();
    hideTimer = setTimeout(hide, 5000);
  };

  return {
    ask(chord, replay) {
      clearTimer();
      asking = chord;
      const meanings = ASKED_CHORDS.get(chord);
      const label = chordLabel(chord);
      const text = document.createElement("span");
      text.className = "text-editor-vim-ask-text";
      text.textContent = `${label}: use it for`;
      const answer = (owner: ChordOwner) => () => {
        onAnswer(chord, owner);
        onDone();
        // Synchronously inside the click, so copy and cut still count as a
        // user gesture; only paste goes async.
        let result: boolean | Promise<boolean>;
        try {
          result = replay(owner);
        } catch {
          result = false;
        }
        if (typeof result === "boolean") confirm(chord, owner, result);
        else void result.then((ok) => confirm(chord, owner, ok), () => confirm(chord, owner, false));
      };
      bar.replaceChildren(
        text,
        button(`Vim${meanings ? ` (${meanings.vim})` : ""}`, "text-editor-vim-ask-choice", answer("vim")),
        button(`Editor${meanings ? ` (${meanings.editor})` : ""}`, "text-editor-vim-ask-choice", answer("editor")),
        button("×", "text-editor-vim-ask-close", () => {
          hide();
          onDone();
        }),
      );
      bar.lastElementChild?.setAttribute("aria-label", "Ask me later");
      bar.lastElementChild?.setAttribute("title", "Ask me later");
      bar.hidden = false;
    },
    refresh(isDecided) {
      if (asking && isDecided(asking)) hide();
    },
    dispose() {
      clearTimer();
      bar.remove();
    },
  };
}
