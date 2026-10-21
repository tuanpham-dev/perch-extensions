// The History list's filter, apart from the view so it can be unit-tested.

// Does a commit match the filter box? Its subject or author (any case), or
// a prefix of its SHA.
export function matchesFilter(commit: { hash: string; subject: string; author: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return commit.subject.toLowerCase().includes(q) || commit.author.toLowerCase().includes(q) || commit.hash.startsWith(q);
}
