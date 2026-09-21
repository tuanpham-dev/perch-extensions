// Small display helpers shared by the details view and the board's cards.

// "Dana Okafor" -> "DO": the badge a comment or a card shows for a person.
export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase() || "?"
  );
}
