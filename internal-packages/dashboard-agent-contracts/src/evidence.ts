/**
 * Evidence — one citation backing something the agent claims.
 *
 * Every piece of evidence points at a real resource through a `trigger://` URI.
 * There is deliberately no free-form `reference: string` field: a string pointer
 * ("run_abc", "src/foo.ts:12", a dashboard URL) can't be resolved, linked, or
 * validated, and it rots. If it can't be expressed as a URI, it isn't evidence.
 */
import { z } from "zod";
import { triggerUriKindSchema, triggerUriSchema } from "./trigger-uri.js";

export const evidenceSchema = z.object({
  /** What kind of resource this cites. Mirrors the URI's resource kinds. */
  kind: triggerUriKindSchema,
  /** The resource itself. */
  uri: triggerUriSchema,
  /** Short human label, e.g. "run_abc123 failed span" or "processOrder.ts:42". */
  label: z.string(),
  /** Optional verbatim snippet (error message, log line, source lines). */
  excerpt: z.string().optional(),
});

export type Evidence = z.infer<typeof evidenceSchema>;
export type EvidenceKind = Evidence["kind"];
