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

/**
 * The model-facing input shape of evidence: `uri` takes the resource's bare id.
 *
 * The strict schema above is what's persisted and rendered. The model can't
 * construct a canonical `trigger://` URI — the grammar embeds the environment
 * id, which the model never sees — so at the tool boundary it cites resources
 * by the ids the read tools returned, and the executor (which has the project
 * and environment context) builds the canonical URI before anything is stored.
 */
export const evidenceRefSchema = z.object({
  kind: triggerUriKindSchema.describe("What kind of resource this cites."),
  uri: z
    .string()
    .min(1)
    .describe(
      "The resource id exactly as a tool returned it: a run id (run_...) for kind run, an error fingerprint for kind error, a queue name for kind queue, a deployment version for kind deployment, or path:line for kind source. A full trigger:// URI is also accepted."
    ),
  label: z.string().describe('Short human label, e.g. "run_abc123 failed span".'),
  excerpt: z
    .string()
    .optional()
    .describe("Optional verbatim snippet (error message, log line, source lines)."),
});

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
