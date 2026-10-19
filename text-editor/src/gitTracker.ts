// A file's base for the gutter's change marks, and the changes measured
// against it — one per open file (models.ts creates it beside the shared
// model), so split panes of the file share one fetch and one diff, and each
// editor instance only draws the result (gitGutter.ts).
//
// The base comes from the host's quick-diff point (git-scm: the file in
// HEAD). It is fetched again when the file loads, after a save, when a tab of
// it becomes active, and when the provider says it moved; the diff re-runs
// shortly after the user stops typing.
import type { TextModel } from "./monacoNs";
import { hostQuickDiff, type QuickDiffBase } from "./host";
import { diffLines, splitLines, type Hunk } from "./quickDiff";
import { gitGutterEnabled, onSettingsChange } from "./settings";

const DIFF_DELAY_MS = 250;

export interface GitBase {
  originalText: string;
  original: string[];
  stagedText: string | null;
  staged: string[] | null;
  stage?: QuickDiffBase["stage"];
}

export class GitTracker {
  base: GitBase | null = null;
  hunks: Hunk[] = [];
  /** Buffer lines the hunks were computed from. */
  lines: string[] = [];
  readonly listeners = new Set<() => void>();

  #filePath: string;
  #model: TextModel;
  #timer: ReturnType<typeof setTimeout> | null = null;
  // Only the newest fetch may land: a slow one from before a save must not
  // overwrite the base read after it.
  #fetchSeq = 0;
  #enabled = gitGutterEnabled();
  #disposed = false;
  #unwatch: (() => void) | null;
  #unsubscribeSettings: () => void;
  #contentListener: { dispose(): void };

  constructor(filePath: string, model: TextModel) {
    this.#filePath = filePath;
    this.#model = model;
    this.#unwatch = hostQuickDiff?.watch(filePath, () => void this.refresh()) ?? null;
    this.#contentListener = model.onDidChangeContent(() => this.#schedule());
    this.#unsubscribeSettings = onSettingsChange(() => {
      const enabled = gitGutterEnabled();
      if (enabled === this.#enabled) return;
      this.#enabled = enabled;
      void this.refresh();
    });
    void this.refresh();
  }

  /** Fetches the base again and re-diffs. Failures keep the last marks. */
  async refresh(): Promise<void> {
    if (this.#disposed) return;
    const seq = ++this.#fetchSeq;
    if (!this.#enabled || !hostQuickDiff) {
      this.base = null;
      this.#recompute();
      return;
    }
    let got: QuickDiffBase | null;
    try {
      got = await hostQuickDiff.getBase(this.#filePath);
    } catch {
      return;
    }
    if (this.#disposed || seq !== this.#fetchSeq) return;
    this.base = got && {
      originalText: got.original,
      original: splitLines(got.original),
      stagedText: got.staged,
      staged: got.staged === null ? null : splitLines(got.staged),
      stage: got.stage,
    };
    this.#recompute();
  }

  #schedule(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#recompute();
    }, DIFF_DELAY_MS);
  }

  /** Re-diffs right away, for an action that needs current hunks. */
  flush(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#recompute();
  }

  #recompute(): void {
    if (this.#disposed) return;
    this.lines = splitLines(this.#model.getValue());
    // Past the diff's edit cap the file shows no marks rather than a wall of them.
    this.hunks = this.base ? (diffLines(this.base.original, this.lines) ?? []) : [];
    for (const listener of [...this.listeners]) listener();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#unwatch?.();
    this.#unwatch = null;
    this.#unsubscribeSettings();
    this.#contentListener.dispose();
    this.listeners.clear();
  }
}
