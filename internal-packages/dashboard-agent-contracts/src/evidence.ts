/**
 * Evidence — one citation backing something the agent claims.
 *
 * Every citation points at a real resource through a `trigger://` URI. There is
 * no free-form `reference: string` field: a string pointer like "src/foo.ts:12"
 * can't be resolved, linked, or validated. If it can't be expressed as a URI, it
 * isn't evidence.
 */
import { z } from "zod";
import { safeParseTriggerUri, triggerUriKindSchema, triggerUriSchema } from "./trigger-uri.js";

export const evidenceSchema = z
  .object({
    /** What kind of resource this cites. Mirrors the URI's resource kinds. */
    kind: triggerUriKindSchema,
    uri: triggerUriSchema,
    /** Short human label, e.g. "run_abc123 failed span" or "processOrder.ts:42". */
    label: z.string(),
    /** Optional verbatim snippet (error message, log line, source lines). */
    excerpt: z.string().optional(),
  })
  // The renderer picks its icon and label from `kind`, so a citation must not
  // claim one resource type while pointing at another.
  .superRefine((evidence, ctx) => {
    const parsed = safeParseTriggerUri(evidence.uri);
    if (parsed.success && parsed.data.kind !== evidence.kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: `kind "${evidence.kind}" does not match the URI's kind "${parsed.data.kind}"`,
      });
    }
  });

export type Evidence = z.infer<typeof evidenceSchema>;
export type EvidenceKind = Evidence["kind"];

/**
 * The model-facing input shape of evidence. The strict schema above is what gets
 * persisted and rendered. The model can't build a canonical URI, because the
 * grammar embeds the environment id it never sees, so at the tool boundary it
 * cites what the read tools gave it and the executor canonicalizes.
 *
 * A kind whose URI needs one bare id cites it as `uri`. The kinds needing more
 * than one part carry those parts as named fields rather than squeezed into a
 * string, because "src/foo.ts:12" in a single `uri` field can't be canonicalized.
 */
const evidenceLabelShape = {
  label: z.string().describe('Short human label, e.g. "run_abc123 failed span".'),
  excerpt: z
    .string()
    .optional()
    .describe("Optional verbatim snippet (error message, log line, source lines)."),
};

/** The kinds whose canonical URI is built from exactly one bare id. */
export const SIMPLE_EVIDENCE_KINDS = [
  "runs",
  "run",
  "error",
  "queue",
  "deployment",
  "report",
  "investigation",
] as const;

const simpleEvidenceRef = <K extends (typeof SIMPLE_EVIDENCE_KINDS)[number]>(kind: K) =>
  z.object({
    kind: z.literal(kind),
    uri: z
      .string()
      .min(1)
      .describe(
        "The resource id exactly as a tool returned it: a run id (run_...) for run, an error fingerprint for error, a queue name for queue, a deployment version for deployment, a report key for report. A full trigger:// URI for this same kind and environment is also accepted."
      ),
    ...evidenceLabelShape,
  });

export const spanEvidenceRefSchema = z.object({
  kind: z.literal("span"),
  runId: z.string().min(1).describe("The run the span belongs to, e.g. run_abc123."),
  spanId: z.string().min(1).describe("The span's id, as the trace returned it."),
  ...evidenceLabelShape,
});

export const sourceEvidenceRefSchema = z.object({
  kind: z.literal("source"),
  path: z
    .string()
    .min(1)
    .describe(
      'Repo-relative path of the file you read, e.g. "src/tasks/send-order-receipt.ts". Never a line suffix — put the line in `line`.'
    ),
  line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The line the claim rests on. Include it whenever you have one."),
  sha: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The commit the file was read at. Omit it and the executor pins the citation to the snapshot this turn read."
    ),
  ...evidenceLabelShape,
});

export const evidenceRefSchema = z.discriminatedUnion("kind", [
  simpleEvidenceRef("runs"),
  simpleEvidenceRef("run"),
  simpleEvidenceRef("error"),
  simpleEvidenceRef("queue"),
  simpleEvidenceRef("deployment"),
  simpleEvidenceRef("report"),
  simpleEvidenceRef("investigation"),
  spanEvidenceRefSchema,
  sourceEvidenceRefSchema,
]);

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type SourceEvidenceRef = z.infer<typeof sourceEvidenceRefSchema>;
export type SpanEvidenceRef = z.infer<typeof spanEvidenceRefSchema>;
