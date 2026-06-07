/**
 * Cursor encoding for keyset pagination over `(created_at, run_id)`.
 *
 * The list query orders by the composite key `(created_at, run_id)`, so a sound
 * cursor must carry BOTH components — cutting on `run_id` alone re-includes and
 * skips rows whenever `run_id` order diverges from `created_at` order.
 *
 * A cursor is an opaque URL-safe base64 token wrapping `{ c: createdAtMs, r:
 * runId }`. Cursors are server-issued (the SDK just echoes
 * `pagination.next`/`previous` back), so this format needs no client update.
 *
 * Legacy cursors were the bare internal run_id (a cuid). They are detected by
 * decode failure: a cuid base64-decodes to non-JSON bytes, so it falls through
 * to `{ kind: "legacy" }` and the old (knowingly unsound) `run_id`-only
 * predicate. In-flight legacy cursors keep working and drain naturally.
 */

import { z } from "zod";

export type DecodedRunsCursor =
  | { kind: "composite"; createdAt: number; runId: string }
  | { kind: "legacy"; runId: string };

// `c` = created_at (ms since epoch), `r` = run_id. Short keys keep the token small.
const CompositeCursor = z.object({
  c: z.number().int(),
  r: z.string().min(1),
});

export function encodeRunsCursor(createdAtMs: number, runId: string): string {
  return Buffer.from(JSON.stringify({ c: createdAtMs, r: runId })).toString("base64url");
}

export function decodeRunsCursor(cursor: string): DecodedRunsCursor {
  try {
    const parsed = CompositeCursor.safeParse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    );
    if (parsed.success) {
      return { kind: "composite", createdAt: parsed.data.c, runId: parsed.data.r };
    }
  } catch {
    // JSON.parse threw — not a composite cursor.
  }

  return { kind: "legacy", runId: cursor };
}
