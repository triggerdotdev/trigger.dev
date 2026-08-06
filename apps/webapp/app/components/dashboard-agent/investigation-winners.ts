export function sameOccurrences(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, occurrence] of a) {
    if (b.get(id) !== occurrence) return false;
  }
  return true;
}

export function reuseWinners(
  previous: Map<string, string> | undefined,
  next: Map<string, string>
): Map<string, string> {
  return previous && sameOccurrences(previous, next) ? previous : next;
}
