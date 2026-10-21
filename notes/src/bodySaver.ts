// One note's typed text against what the server last confirmed. Saves run
// one at a time, in order, so an older save can't land after a newer one; and
// the note only counts as clean when the text now in the editor is the text
// that was saved, so typing that arrives while a save is in flight stays
// dirty and gets the next save.
export class BodySaver {
  private current: string;
  private saved: string;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly save: (body: string) => Promise<void>;

  constructor(save: (body: string) => Promise<void>, initial: string) {
    this.save = save;
    this.current = initial;
    this.saved = initial;
  }

  get dirty(): boolean {
    return this.current !== this.saved;
  }

  get text(): string {
    return this.current;
  }

  edit(text: string): void {
    this.current = text;
  }

  // Another device's edit: taken (true) unless there's unsaved typing here.
  external(body: string): boolean {
    if (this.dirty) return false;
    this.current = body;
    this.saved = body;
    return true;
  }

  // Saves the text as it is now, after any save already under way. Rejects
  // with that save's error; the text then stays dirty for the next try.
  flush(): Promise<void> {
    const value = this.current;
    const run = this.chain.then(async () => {
      if (value === this.saved) return;
      await this.save(value);
      this.saved = value;
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
