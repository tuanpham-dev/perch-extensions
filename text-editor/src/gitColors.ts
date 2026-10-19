// The change marks' colors, from the active theme the way VS Code reads them:
// editorGutter.addedBackground / modifiedBackground / deletedBackground, and
// VS Code's own defaults for themes that leave them out. Monaco has no such
// colors of its own (they belong to VS Code's source-control view), so they
// can't resolve through its color registry; applyHostTheme hands the theme's
// colors here instead. The gutter bars read them as CSS variables, and the
// overview ruler, which takes a color value per decoration, through
// gitColors() plus a change notification to redraw.

export interface GitColors {
  added: string;
  modified: string;
  deleted: string;
}

// VS Code's registered defaults (src/vs/workbench/contrib/scm/browser/
// dirtydiffDecorator): the deleted mark falls back to editorError.foreground.
const DARK: GitColors = { added: "#487e02", modified: "#1b81a8", deleted: "#f14c4c" };
const LIGHT: GitColors = { added: "#48985d", modified: "#2090d3", deleted: "#e51400" };

// One state per page, not per module: applyHostTheme runs in the lazily
// loaded Monaco chunk and the gutter in the eager client bundle, and each
// bundle gets its own copy of this module. The CSS variables are shared
// through the document either way; the ruler colors and the listeners have
// to be shared through the global object.
interface State {
  current: GitColors;
  ruler: GitColors;
  minimap: GitColors;
  listeners: Set<() => void>;
}

const STATE_KEY = "__perchTextEditorGitColors";
const state: State = ((globalThis as unknown as Record<string, State | undefined>)[STATE_KEY] ??= {
  current: DARK,
  ruler: { added: rulerColor(DARK.added), modified: rulerColor(DARK.modified), deleted: rulerColor(DARK.deleted) },
  minimap: DARK,
  listeners: new Set(),
});

export function gitColors(): GitColors {
  return state.current;
}

/** The overview ruler's marks: the theme's editorOverviewRuler.*Foreground,
 *  else the gutter color at VS Code's default 60%. */
export function gitRulerColors(): GitColors {
  return state.ruler;
}

/** The minimap gutter's marks: the theme's minimapGutter.*Background, else
 *  the gutter colors, as VS Code falls back. */
export function gitMinimapColors(): GitColors {
  return state.minimap;
}

export function onGitColorsChange(cb: () => void): () => void {
  state.listeners.add(cb);
  return () => state.listeners.delete(cb);
}

function rulerColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}99` : color;
}

export function setGitColors(themeColors: Record<string, string>, light: boolean): void {
  const defaults = light ? LIGHT : DARK;
  const current: GitColors = {
    added: themeColors["editorGutter.addedBackground"] ?? defaults.added,
    modified: themeColors["editorGutter.modifiedBackground"] ?? defaults.modified,
    deleted: themeColors["editorGutter.deletedBackground"] ?? themeColors["editorError.foreground"] ?? defaults.deleted,
  };
  state.current = current;
  state.ruler = {
    added: themeColors["editorOverviewRuler.addedForeground"] ?? rulerColor(current.added),
    modified: themeColors["editorOverviewRuler.modifiedForeground"] ?? rulerColor(current.modified),
    deleted: themeColors["editorOverviewRuler.deletedForeground"] ?? rulerColor(current.deleted),
  };
  state.minimap = {
    added: themeColors["minimapGutter.addedBackground"] ?? current.added,
    modified: themeColors["minimapGutter.modifiedBackground"] ?? current.modified,
    deleted: themeColors["minimapGutter.deletedBackground"] ?? current.deleted,
  };
  const root = document.documentElement.style;
  root.setProperty("--te-git-added", current.added);
  root.setProperty("--te-git-modified", current.modified);
  root.setProperty("--te-git-deleted", current.deleted);
  for (const cb of [...state.listeners]) cb();
}
