// Vim keybindings, off unless `textEditor.vim` says otherwise.
//
// monaco-vim does the modal work (it is CodeMirror's vim engine adapted to
// Monaco); this module owns the parts that are ours: when to attach, when to
// tear down, and what `:w` and `:q` should actually do in an app where a
// "buffer" is a tab.
//
// The Ex commands are the awkward part. `Vim.defineEx` writes to global state,
// so there is exactly one `:w` handler no matter how many editors are open,
// and it has to work out which buffer the user meant. It asks, at the moment
// the command runs, which of the editors running vim has focus, rather than
// tracking focus as it moves: an Ex command can only be typed into a focused
// editor, so the answer is correct by construction, with no listener to miss
// and no stale reference that could make `:w` save the wrong file.
import { useEffect } from "react";
import { getLoadedChunk, type ExParams, type VimAdapter } from "./monacoLoader";
import type { CodeEditor } from "./monacoNs";
import { ASKED_CHORDS, createChordPrompt, type ChordPrompt } from "./chordPrompt";
import { chordOwner, onSettingsChange, setChordOwner, vimEnabled, type ChordOwner } from "./settings";

export interface VimActions {
  /** Saves; resolves false when the save failed, so `:wq` can refuse to close. */
  save: () => Promise<boolean>;
  /** Closes this view's tab. */
  close: () => void;
  /** Unsaved changes — what `:q` refuses over and `:q!` ignores. */
  isDirty: () => boolean;
}

// Actions for every editor currently running vim, keyed by the editor itself,
// so the global Ex handlers can look up whichever one has focus.
const actionsByEditor = new Map<CodeEditor, VimActions>();

// The "vim or editor?" prompt of every editor running vim, so the shared keymap
// can ask in whichever editor the chord was pressed.
const promptsByEditor = new Map<CodeEditor, ChordPrompt>();

let exCommandsRegistered = false;

// The actions of the editor the user is typing the Ex command into. Null when
// nothing is focused or that editor isn't running vim — in which case the
// command quietly does nothing, which beats acting on an arbitrary buffer.
function focusedActions(): VimActions | null {
  // The map is scanned rather than monaco.editor.getEditors(): the panes inside
  // a diff editor are not reliably listed there, and every editor running vim
  // is a key here anyway.
  for (const [editor, actions] of actionsByEditor) {
    if (editor.hasTextFocus()) return actions;
  }
  return null;
}

/**
 * Whether the user typed the command with a `!`. monaco-vim parses `:q!` as the
 * command `q` with the bang left in the raw input rather than handing it to the
 * handler, so it is read back off `params.input` — the line as typed, minus the
 * leading colon, e.g. `q!` or `1,5w`.
 */
function hasBang(params: ExParams | undefined): boolean {
  return /^\s*(?:[^a-zA-Z]*\s*)?[a-zA-Z]+!/.test(params?.input ?? "");
}

function registerExCommands(): void {
  if (exCommandsRegistered) return;
  const vim = getLoadedChunk()?.VimMode?.Vim;
  if (!vim) return;
  exCommandsRegistered = true;

  // Note the shape: defineEx insists the short form be a prefix of the long
  // one, so `q!` cannot be registered as a command of its own — it is `quit`
  // with a bang, exactly as in vim, and hasBang() digs it back out.
  vim.defineEx("write", "w", () => {
    void focusedActions()?.save();
  });

  // Vim refuses to quit a modified buffer, and so does this: the host's
  // closeViewerTab has no confirmation of its own, so without the check `:q`
  // would be a silent way to lose edits.
  vim.defineEx("quit", "q", (cm, params) => {
    const actions = focusedActions();
    if (!actions) return;
    if (actions.isDirty() && !hasBang(params)) {
      // Through monaco-vim's own notification slot, not by writing to the
      // status node: the node holds the mode indicator and the Ex input, and
      // overwriting it would tear out elements the status bar still holds
      // references to.
      cm.openNotification("E37: No write since last change (add ! to override)");
      return;
    }
    actions.close();
  });

  // `:wq` closes only if the write actually landed. The views report save
  // failures in their toolbar rather than throwing, so without checking, a
  // failed write here would close the tab and take the edits with it.
  const writeQuit = () => {
    const actions = focusedActions();
    if (!actions) return;
    void actions.save().then((saved) => {
      if (saved) actions.close();
    });
  };
  vim.defineEx("wq", "wq", writeQuit);
  vim.defineEx("xit", "x", writeQuit);
}

let keymapWrapped = false;

// A no-op command: returning it tells monaco-vim the key was handled, so the
// event is swallowed and neither vim nor the editor acts on it.
const swallow = () => {};

/**
 * Performs a chord whose keypress was swallowed to ask about it, on the side
 * the user just chose. Vim gets the key fed through its own handler, skipping
 * this keymap (which would only ask again); the editor gets the chord's action
 * run directly, since the original keydown is long gone and can't be re-sent.
 * Called straight from the answer's click, before any await, so the editor's
 * copy and cut still run inside a user gesture.
 */
function replayChord(chord: string, owner: ChordOwner, cm: unknown, editor: CodeEditor): boolean | Promise<boolean> {
  if (owner === "editor") return ASKED_CHORDS.get(chord)?.runInEditor(editor) ?? false;
  const vim = getLoadedChunk()?.VimMode?.Vim;
  if (!vim) return false;
  // `Ctrl-a` -> `<C-a>`, vim's own spelling of the key.
  vim.handleKey(cm, `<C-${chord.slice(-1)}>`);
  return true;
}

/**
 * Decides, per Ctrl chord, whether vim or the editor gets it, like VS Code
 * Vim's handleKeys: `textEditor.vimEditorKeys` lists the chords that keep
 * their editor meaning (Ctrl+C copies, Ctrl+V pastes), `textEditor.vimKeys`
 * the ones vim keeps. A chord in neither that means something to both sides
 * (ASKED_CHORDS) raises a prompt the first time it is pressed. That press is
 * held back until the user answers, then performed on the chosen side
 * (replayChord), so neither side acts on a key before it has an owner.
 *
 * monaco-vim asks its keymap's `call` for a command on every keydown, and only
 * swallows the event when it gets one back. Answering "nothing" for an editor
 * chord therefore hands it on untouched: Monaco's own keybindings and the
 * browser's default action (the native copy and paste events) run exactly as
 * they do with vim off. Blocking the event before vim sees it would not work,
 * since preventDefault is what cancels the native clipboard action.
 *
 * The prompt is decided before vim is consulted, from the chord alone: asking
 * vim whether it would handle a key updates its pending-key state, which a
 * swallowed key must not do.
 *
 * The keymap is shared by every adapter, like the Ex commands, so it is
 * wrapped once. The settings are read per keypress, so a change applies to
 * open tabs at once.
 */
function wrapKeymap(): void {
  if (keymapWrapped) return;
  const keymap = getLoadedChunk()?.VimMode?.keyMap?.vim;
  if (!keymap) return;
  keymapWrapped = true;
  const call = keymap.call;
  keymap.call = function (key, cm) {
    // The last character is the key itself; its case depends on Shift and
    // Caps Lock, neither of which should change whether the chord matches.
    const chord = key.slice(0, -1) + key.slice(-1).toLowerCase();
    const owner = chordOwner(chord);
    if (owner === "editor") return undefined;
    if (owner === null && ASKED_CHORDS.has(chord)) {
      const editor = (cm as { editor?: CodeEditor } | null)?.editor;
      const prompt = editor && promptsByEditor.get(editor);
      if (prompt) {
        prompt.ask(chord, (answer) => replayChord(chord, answer, cm, editor));
        return swallow;
      }
    }
    return call.call(this, key, cm);
  };
}

/**
 * Attaches vim to `editor` while the setting is on, and re-attaches when it is
 * toggled — no reload needed. `statusNode` is where monaco-vim draws the mode
 * line, the `:` prompt and search input; without it the mode is invisible and
 * Ex commands can't be typed at all.
 *
 * Pass a null editor (a read-only diff side, an editor that hasn't been created
 * yet) and this does nothing.
 */
export function useVimMode(
  editor: CodeEditor | null,
  statusNode: HTMLElement | null,
  actions: VimActions,
  // Bumped by the caller when `editor` is replaced, since a ref's .current
  // changing is invisible to React's dependency comparison.
  editorKey: unknown,
): void {
  useEffect(() => {
    if (!editor || !statusNode) return;
    let adapter: VimAdapter | null = null;
    let prompt: ChordPrompt | null = null;

    const attach = () => {
      const chunk = getLoadedChunk();
      if (adapter || !chunk || !vimEnabled()) return;
      registerExCommands();
      wrapKeymap();
      actionsByEditor.set(editor, actions);
      adapter = chunk.initVimMode(editor, statusNode);
      prompt = createChordPrompt(statusNode, setChordOwner, () => editor.focus());
      promptsByEditor.set(editor, prompt);
    };

    const detach = () => {
      adapter?.dispose();
      adapter = null;
      prompt?.dispose();
      prompt = null;
      promptsByEditor.delete(editor);
      actionsByEditor.delete(editor);
      // Each attach builds a fresh StatusBar that appends its spans to this
      // node without clearing it first, so leaving the old ones behind would
      // stack a second mode indicator on every toggle.
      statusNode.textContent = "";
    };

    attach();
    const unsubscribe = onSettingsChange(() => {
      if (vimEnabled()) attach();
      else detach();
      // Answered elsewhere (another pane, another device, Settings): stop asking.
      prompt?.refresh((chord) => chordOwner(chord) !== null);
    });

    return () => {
      unsubscribe();
      detach();
    };
    // `actions` is rebuilt every render by its callers; re-attaching vim on
    // each keystroke would be absurd, so the effect deliberately keys on the
    // editor identity instead and reads the latest actions through the map,
    // which attach() refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, statusNode, editorKey]);

  // Keep the map pointing at the current render's closures without
  // re-attaching, so `:w` always saves through the live save function.
  useEffect(() => {
    if (editor && actionsByEditor.has(editor)) actionsByEditor.set(editor, actions);
  });
}
