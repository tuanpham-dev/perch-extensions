// Which issue rows are selected. One set of issue KEYS, shared by both panes
// (the same ticket can be listed in each, and it is one ticket), so every
// operation here is over keys rather than over rows or indices.
//
// Every function returns a new Set - the store holds the selection in state
// and React must see a new reference to re-render the rows.

export function toggle(selection: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selection);
  if (!next.delete(key)) next.add(key);
  return next;
}

// The inclusive run between the anchor and the clicked row, in list order, so
// shift-clicking upwards picks the same rows as shift-clicking downwards.
// With no usable anchor - nothing selected yet, or the anchor row has since
// been filtered away - the clicked row is the whole range.
export function rangeOf(keys: readonly string[], anchor: string | null, target: string): string[] {
  const to = keys.indexOf(target);
  if (to === -1) return [];
  const from = anchor === null ? -1 : keys.indexOf(anchor);
  if (from === -1) return [target];
  return from <= to ? keys.slice(from, to + 1) : keys.slice(to, from + 1);
}

export function selectRange(
  selection: ReadonlySet<string>,
  keys: readonly string[],
  anchor: string | null,
  target: string,
): Set<string> {
  const next = new Set(selection);
  for (const key of rangeOf(keys, anchor, target)) next.add(key);
  return next;
}

// A plain drag replaces the selection; a Ctrl/Cmd-held drag adds to whatever
// was selected when the drag armed. That snapshot is why `base` is passed in
// rather than read live: the marquee hook recomputes on every frame, so
// unioning with the current selection would make the band sticky - rows it
// had already passed over could never fall back out of it.
export function applyMarquee(
  base: ReadonlySet<string>,
  ids: readonly string[],
  additive: boolean,
): Set<string> {
  return additive ? new Set([...base, ...ids]) : new Set(ids);
}

// Drops keys no pane lists any more, so a refresh that filters a selected
// issue away can't leave the count naming tickets nothing on screen can show.
export function prune(selection: ReadonlySet<string>, knownKeys: Iterable<string>): Set<string> {
  const known = new Set(knownKeys);
  const next = new Set<string>();
  for (const key of selection) {
    if (known.has(key)) next.add(key);
  }
  return next;
}

// The selected issues in the order the panes list them, which is the order
// the agent's brief and the Jira transitions follow. Built from the lists
// rather than from the Set, since a Set's iteration order is insertion order
// and a marquee or a shift-range inserts in whatever order it swept.
export function orderedSelection<T extends { key: string }>(
  lists: readonly (readonly T[])[],
  selection: ReadonlySet<string>,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const issue of list) {
      if (!selection.has(issue.key) || seen.has(issue.key)) continue;
      seen.add(issue.key);
      out.push(issue);
    }
  }
  return out;
}
