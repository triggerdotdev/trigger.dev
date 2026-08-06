/**
 * Identity handling for the investigation winners map (see
 * `winningInvestigationOccurrences` in `DashboardAgentMessages.tsx`).
 *
 * Kept free of component imports so it stays testable on its own.
 */

/** Content equality, so a recompute that changed nothing can be thrown away. */
export function sameOccurrences(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, occurrence] of a) {
    if (b.get(id) !== occurrence) return false;
  }
  return true;
}

/** Returns `previous` when the winners are unchanged, so the reference is reusable. */
export function reuseWinners(
  previous: Map<string, string> | undefined,
  next: Map<string, string>
): Map<string, string> {
  return previous && sameOccurrences(previous, next) ? previous : next;
}
