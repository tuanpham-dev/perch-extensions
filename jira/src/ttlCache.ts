// A small time-limited cache for ticket details, so reopening a ticket - in
// the popover, the editor tab, or when its brief is built for an agent -
// doesn't cost another round trip to Atlassian each time.
//
// An entry is only ever served while it is younger than the TTL; past that it
// is dropped on the next read, and sweep() clears every expired entry so the
// cache gives memory back even for tickets nobody opens again. The TTL is read
// through a function rather than fixed at construction, so changing the
// setting applies to the very next read, and a TTL of 0 turns caching off.
//
// Capped as well as timed: a long session of browsing tickets would otherwise
// keep every one of them until it expired. The oldest-used entry goes first -
// a read moves an entry to the back of the Map's insertion order.
export interface TtlCacheOptions {
  ttlMs: () => number;
  max: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  at: number;
}

export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly ttlMs: () => number;
  private readonly max: number;
  private readonly now: () => number;

  constructor({ ttlMs, max, now = Date.now }: TtlCacheOptions) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
  }

  private fresh(entry: Entry<V>): boolean {
    const ttl = this.ttlMs();
    return ttl > 0 && this.now() - entry.at < ttl;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (!this.fresh(entry)) {
      this.entries.delete(key);
      return undefined;
    }
    // Most recently used goes to the back, so the cap evicts the least used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    // Caching off: don't hold the value at all, so nothing lingers to be
    // served if the TTL is turned back up later.
    if (this.ttlMs() <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.now() });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  // Drops every expired entry. Run on a timer, so expiry frees memory rather
  // than waiting for a read that may never come.
  sweep(): void {
    for (const [key, entry] of this.entries) {
      if (!this.fresh(entry)) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
