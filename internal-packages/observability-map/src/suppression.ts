// The reason runs to the end of the line: `.` does not match a newline, so a suppression on one
// line cannot pick up a reason from the next one.
const PATTERN = /obs-map-disable-next-line\s+([a-z-]+)\s+--\s+(.+)/g;

/** Check id to reason. A suppression without a reason is ignored. */
export function suppressedChecks(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of source.matchAll(PATTERN)) {
    const [, id, reason] = match;
    if (id && reason && reason.trim().length > 0) out.set(id, reason.trim());
  }
  return out;
}
