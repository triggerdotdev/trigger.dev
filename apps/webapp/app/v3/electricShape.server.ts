/**
 * Characters rejected in realtime tag values — the single source of truth
 * shared by the apiBuilder Zod refine (`realtime.v1.runs.ts`) and the runtime
 * sanitiser. Rejects control chars/DEL, backslash, and double-quote. Single
 * quotes are allowed and escaped (`'` → `''`) in `sanitizeRealtimeTagForSql`.
 */
export const UNSAFE_REALTIME_TAG_CHARS = /[\x00-\x1f\x7f\\"]/;

/**
 * Sanitise a tag value for interpolation into an Electric Shape `where` clause:
 * reject unsafe chars, escape single quotes per SQL standard.
 */
function sanitizeRealtimeTagForSql(tag: string): string {
  if (typeof tag !== "string" || tag.length === 0) {
    throw new Error("Invalid realtime tag: empty");
  }
  if (UNSAFE_REALTIME_TAG_CHARS.test(tag)) {
    throw new Error(`Invalid realtime tag: ${JSON.stringify(tag)} — contains unsafe character`);
  }
  return tag.replace(/'/g, "''");
}

export function sanitizeRealtimeTagsForSql(tags: string[]): string[] {
  return tags.map(sanitizeRealtimeTagForSql);
}
