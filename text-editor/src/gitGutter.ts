// The gutter's change marks for one editor instance, VS Code style: a bar
// beside added and changed lines, a triangle where lines were deleted, the
// same colors on the scrollbar's overview ruler, and a peek opened by
// clicking a mark that shows the old lines with Stage change, Revert and
// previous/next.
//
// The base and the hunks live on the file's GitTracker, shared by every
// pane showing the file; this module only draws them and acts on them.
import type { MonacoNs, StandaloneDiffEditor, StandaloneEditor, TextModel } from "./monacoNs";
import type { FileEntry } from "./models";
import type { GitTracker } from "./gitTracker";
import { eolOf, isStaged, kindOf, lineEdit, revertedLines, stagedLinesFor, type Hunk } from "./quickDiff";
import { gitMinimapColors, gitRulerColors, onGitColorsChange } from "./gitColors";

// The peek's diff shows the change with this many unchanged lines around
// it, and scrolls inside itself past PEEK_MAX_LINES.
const PEEK_CONTEXT_LINES = 3;
const PEEK_MAX_LINES = 18;
// Title bar and top/bottom frame heights, matching style.css.
const PEEK_HEAD_PX = 22;
const PEEK_FRAME_PX = 1;

let peekSeq = 0;

export interface GitGutter {
  next(): void;
  previous(): void;
  dispose(): void;
}

// The gutter in the editor that last had focus, for the next/previous
// change commands, which run from the app's own keybinding layer.
let focused: GitGutter | null = null;

export function focusedGitGutter(): GitGutter | null {
  return focused;
}

// The focused editor's tab may since have been switched away from; a
// keypress must not move a cursor the user can't see.
function visible(editor: StandaloneEditor): boolean {
  return (editor.getDomNode()?.offsetParent ?? null) !== null;
}

/** The model line a hunk's mark sits on (1-based): its first line, or for a
 *  deletion the line above the gap (line 1 when the gap is at the top). */
function markLine(h: Hunk): number {
  return kindOf(h) === "deleted" ? Math.max(h.bStart, 1) : h.bStart + 1;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function attachGitGutter(monaco: MonacoNs, editor: StandaloneEditor, entry: FileEntry): GitGutter {
  const tracker = entry.git as GitTracker;
  const marks = editor.createDecorationsCollection();
  const peekOpen = editor.createContextKey<boolean>("textEditorGitPeekOpen", false);

  // The open peek: which hunk it shows (by index, re-found after edits) and
  // the view zone making room for it.
  let peek: { index: number; anchor: Hunk; zoneId: string | null; error: string | null; busy: boolean } | null = null;

  // The peek is drawn the way VS Code's own is: an empty view zone opens a
  // gap between the lines, and an overlay widget kept on top of that gap
  // holds the content. A view zone's own node sits under the text layer,
  // which takes every click, so buttons placed in it could never be pressed.
  const id = ++peekSeq;
  const peekHost = document.createElement("div");
  peekHost.className = "te-git-peek-host";
  const peekWidget = {
    getId: () => `te-git-peek-${id}`,
    getDomNode: () => peekHost,
    getPosition: () => null,
  };
  let widgetAdded = false;
  const layoutPeekHost = () => {
    const info = editor.getLayoutInfo();
    peekHost.style.width = `${info.width - info.minimap.minimapWidth - info.verticalScrollbarWidth}px`;
  };
  const layoutListener = editor.onDidLayoutChange(layoutPeekHost);
  // Focus is on a button or in the peek's diff after a click, outside the
  // editor's own keybindings. Capture, so the diff editor can't swallow it.
  peekHost.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closePeek();
      editor.focus();
    },
    true,
  );

  // The peek's body is a real inline diff editor, as VS Code's is: the file
  // in the last commit against the live model, scrolled to the change. Its
  // line numbers, diff colors and syntax colors are the theme's own, the
  // same tokens VS Code uses. Kept across re-renders while the peek is open
  // (typing re-renders it), and dropped when it closes.
  const diffHost = document.createElement("div");
  diffHost.className = "te-git-peek-body";
  let diff: StandaloneDiffEditor | null = null;
  let originalModel: TextModel | null = null;
  const disposeDiff = () => {
    diff?.dispose();
    diff = null;
    originalModel?.dispose();
    originalModel = null;
  };

  const render = () => {
    marks.set(
      tracker.hunks.map((h) => {
        const kind = kindOf(h);
        const line = markLine(h);
        const endLine = kind === "deleted" ? line : h.bEnd;
        const cls = kind === "deleted" && h.bStart === 0 ? "te-git-deleted-top" : `te-git-${kind}`;
        return {
          range: new monaco.Range(line, 1, endLine, 1),
          options: {
            linesDecorationsClassName: `te-git ${cls}`,
            overviewRuler: { color: gitRulerColors()[kind], position: monaco.editor.OverviewRulerLane.Left },
            minimap: { color: gitMinimapColors()[kind], position: monaco.editor.MinimapPosition.Gutter },
          },
        };
      }),
    );
    if (peek) reanchorPeek();
  };

  // After edits the open peek follows its change: the hunk at the same index
  // if it still overlaps where the old one was, else whichever hunk now
  // covers that spot. None left means the change is gone, so the peek closes.
  const reanchorPeek = () => {
    if (!peek) return;
    const old = peek.anchor;
    const covers = (h: Hunk) => h.bStart <= Math.max(old.bEnd, old.bStart + 1) && old.bStart <= Math.max(h.bEnd, h.bStart + 1);
    let index = covers(tracker.hunks[peek.index] ?? { aStart: 0, aEnd: 0, bStart: -9, bEnd: -9 }) ? peek.index : -1;
    if (index < 0) index = tracker.hunks.findIndex(covers);
    if (index < 0) return closePeek();
    showPeek(index, peek.error);
  };

  const closePeek = () => {
    if (peek?.zoneId) {
      const zoneId = peek.zoneId;
      editor.changeViewZones((acc) => acc.removeZone(zoneId));
    }
    if (widgetAdded) editor.removeOverlayWidget(peekWidget);
    widgetAdded = false;
    peekHost.replaceChildren();
    disposeDiff();
    peek = null;
    peekOpen.set(false);
  };

  // The peek's title-bar actions, VS Code's codicons (the host loads the font).
  const button = (icon: string, title: string, onClick: () => void, disabled = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `te-git-peek-button codicon codicon-${icon}`;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.disabled = disabled;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  };

  const showDiff = (h: Hunk, bodyPx: number) => {
    const base = tracker.base;
    const model = entry.model;
    if (!base || !model) return;
    const fontInfo = editor.getOption(monaco.editor.EditorOption.fontInfo);
    if (!diff) {
      diff = monaco.editor.createDiffEditor(diffHost, {
        renderSideBySide: false,
        readOnly: true,
        originalEditable: false,
        renderIndicators: false,
        renderMarginRevertIcon: false,
        renderOverviewRuler: false,
        enableSplitViewResizing: false,
        ignoreTrimWhitespace: false,
        hideUnchangedRegions: { enabled: false },
        minimap: { enabled: false },
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 8,
        scrollBeyondLastLine: false,
        stickyScroll: { enabled: false },
        contextmenu: false,
        overviewRulerLanes: 0,
        fontFamily: fontInfo.fontFamily,
        fontSize: fontInfo.fontSize,
        lineHeight: fontInfo.lineHeight,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
      });
    }
    if (!originalModel) {
      originalModel = monaco.editor.createModel(base.originalText, model.getLanguageId());
    } else if (originalModel.getValue() !== base.originalText) {
      originalModel.setValue(base.originalText);
    }
    if (diff.getModel()?.modified !== model) diff.setModel({ original: originalModel, modified: model });
    const info = editor.getLayoutInfo();
    diff.layout({ width: info.width - info.minimap.minimapWidth - info.verticalScrollbarWidth, height: bodyPx });
    // In the inline view the old lines are drawn above their place in the
    // live model, so centering on the change's spot there centers both.
    const target = markLine(h);
    const reveal = () => diff?.getModifiedEditor().revealLineInCenter(target, monaco.editor.ScrollType.Immediate);
    reveal();
    const once = diff.onDidUpdateDiff(() => {
      once.dispose();
      reveal();
    });
  };

  const showPeek = (index: number, error: string | null = null) => {
    const h = tracker.hunks[index];
    const base = tracker.base;
    if (!h || !base) return closePeek();
    const kind = kindOf(h);
    const staged = isStaged(base.original, base.staged, tracker.lines, h);
    const busy = peek?.busy ?? false;
    const fontInfo = editor.getOption(monaco.editor.EditorOption.fontInfo);
    const lineHeight = fontInfo.lineHeight;

    const dom = document.createElement("div");
    dom.className = `te-git-peek te-git-peek-${kind}`;
    // VS Code's peek points at its change with a small arrow in the change's
    // color, sitting over the gutter mark.
    const arrow = document.createElement("div");
    arrow.className = "te-git-peek-arrow";
    const layout = editor.getLayoutInfo();
    arrow.style.left = `${layout.decorationsLeft}px`;
    const head = document.createElement("div");
    head.className = "te-git-peek-head";
    const title = document.createElement("span");
    title.className = "te-git-peek-title";
    title.textContent = entry.filePath.slice(entry.filePath.lastIndexOf("/") + 1);
    const description = document.createElement("span");
    description.className = "te-git-peek-description";
    // VS Code's wording, with its source named the same way: "<what it is
    // compared with> - N of M changes".
    const count = `${index + 1} of ${tracker.hunks.length} ${tracker.hunks.length === 1 ? "change" : "changes"}`;
    description.textContent = `Git Last Commit${staged ? " (staged)" : ""} - ${count}`;
    head.append(title, description);
    if (error) {
      const err = document.createElement("span");
      err.className = "te-git-peek-error";
      err.textContent = error;
      err.title = error;
      head.append(err);
    }
    const buttons = document.createElement("span");
    buttons.className = "te-git-peek-buttons";
    const canStage = !!base.stage && base.staged !== null;
    buttons.append(
      button(
        "add",
        staged ? "Stage Change (already staged)" : canStage ? "Stage Change" : "Stage Change (nothing staged to add to)",
        () => void stage(),
        staged || !canStage || busy,
      ),
      button("discard", "Revert Change", revert, busy),
      button("arrow-up", "Previous Change (Shift+Alt+F5)", () => move(-1)),
      button("arrow-down", "Next Change (Alt+F5)", () => move(1)),
      button("close", "Close (Escape)", closePeek),
    );
    head.append(buttons);

    dom.append(arrow, head, diffHost);

    const changeLines = h.aEnd - h.aStart + (h.bEnd - h.bStart);
    const bodyLines = Math.min(changeLines + 2 * PEEK_CONTEXT_LINES, PEEK_MAX_LINES);
    const bodyPx = bodyLines * lineHeight;
    const heightInPx = PEEK_HEAD_PX + bodyPx + 2 * PEEK_FRAME_PX;
    const afterLineNumber = kind === "deleted" ? h.bStart : h.bEnd;

    peekHost.replaceChildren(dom);
    peekHost.style.height = `${heightInPx}px`;
    if (!widgetAdded) {
      editor.addOverlayWidget(peekWidget);
      widgetAdded = true;
      layoutPeekHost();
    }
    const previousZone = peek?.zoneId ?? null;
    let zoneId: string | null = null;
    editor.changeViewZones((acc) => {
      if (previousZone) acc.removeZone(previousZone);
      zoneId = acc.addZone({
        afterLineNumber,
        heightInPx,
        domNode: document.createElement("div"),
        onDomNodeTop: (top) => {
          peekHost.style.top = `${top}px`;
        },
      });
    });
    peek = { index, anchor: h, zoneId, error, busy };
    peekOpen.set(true);
    showDiff(h, bodyPx);
    editor.revealLinesInCenterIfOutsideViewport(markLine(h), afterLineNumber + Math.ceil(heightInPx / lineHeight));
  };

  const revert = () => {
    tracker.flush();
    if (!peek || !tracker.base || !entry.model) return;
    const h = tracker.hunks[peek.index];
    if (!h) return closePeek();
    const edit = lineEdit(tracker.lines, revertedLines(tracker.base.original, tracker.lines, h), entry.model.getEOL());
    closePeek();
    if (!edit) return;
    editor.pushUndoStop();
    editor.executeEdits("git-revert", [
      { range: new monaco.Range(edit.startLine, edit.startColumn, edit.endLine, edit.endColumn), text: edit.text },
    ]);
    editor.pushUndoStop();
    editor.setPosition({ lineNumber: edit.startLine, column: 1 });
    // Back from the peek's button, so Ctrl+Z undoes the revert right away.
    editor.focus();
  };

  const stage = async () => {
    tracker.flush();
    const base = tracker.base;
    if (!peek || !base?.stage || !base.staged || base.stagedText === null) return;
    const index = peek.index;
    const h = tracker.hunks[index];
    if (!h) return closePeek();
    const result = stagedLinesFor(base.original, base.staged, tracker.lines, h);
    if ("error" in result) return showPeek(index, result.error);
    peek.busy = true;
    showPeek(index);
    let error: string | null = null;
    try {
      await base.stage(result.lines.join(eolOf(base.stagedText)));
    } catch (err) {
      error = messageOf(err);
    }
    // The provider fires its watch after a stage; this makes sure the peek
    // reads the new staged version even if that event is still on its way.
    await tracker.refresh();
    if (!peek) return;
    peek.busy = false;
    showPeek(Math.min(peek.index, tracker.hunks.length - 1), error);
  };

  // Next/previous change, wrapping at the file's ends; an open peek moves
  // with the cursor.
  const move = (dir: 1 | -1) => {
    if (!visible(editor)) return;
    tracker.flush();
    const hunks = tracker.hunks;
    if (hunks.length === 0) return;
    let index: number;
    if (peek) {
      index = (peek.index + dir + hunks.length) % hunks.length;
    } else {
      const line = editor.getPosition()?.lineNumber ?? 1;
      if (dir === 1) {
        index = hunks.findIndex((h) => markLine(h) > line);
        if (index < 0) index = 0;
      } else {
        index = -1;
        for (let i = hunks.length - 1; i >= 0; i--) {
          if (markLine(hunks[i]) < line) {
            index = i;
            break;
          }
        }
        if (index < 0) index = hunks.length - 1;
      }
    }
    const line = markLine(hunks[index]);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenterIfOutsideViewport(line);
    if (peek) showPeek(index);
    editor.focus();
  };

  const mouseDown = editor.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
    const line = e.target.position?.lineNumber;
    if (line === undefined) return;
    tracker.flush();
    const index = tracker.hunks.findIndex((h) =>
      kindOf(h) === "deleted" ? markLine(h) === line : line > h.bStart && line <= h.bEnd,
    );
    if (index < 0) return;
    if (peek?.index === index) closePeek();
    else showPeek(index);
    // A click in the line-decorations strip doesn't focus the editor, and
    // Escape (close the peek) is an editor keybinding.
    editor.focus();
  });

  editor.addCommand(monaco.KeyCode.Escape, closePeek, "textEditorGitPeekOpen");

  const api: GitGutter = {
    next: () => move(1),
    previous: () => move(-1),
    dispose: () => {
      closePeek();
      marks.clear();
      tracker.listeners.delete(render);
      mouseDown.dispose();
      focusListener.dispose();
      disposeDiff();
      layoutListener.dispose();
      unsubscribeColors();
      if (focused === api) focused = null;
    },
  };
  const focusListener = editor.onDidFocusEditorWidget(() => {
    focused = api;
  });
  tracker.listeners.add(render);
  const unsubscribeColors = onGitColorsChange(render);
  render();
  return api;
}
