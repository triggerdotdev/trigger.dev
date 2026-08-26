/** Every citation must be a `trigger://` URI. There is no free-form reference field. */
import { z } from "zod";
import { safeParseTriggerUri, triggerUriKindSchema, triggerUriSchema } from "./trigger-uri.js";

export const evidenceSchema = z
  .object({
    kind: triggerUriKindSchema,
    uri: triggerUriSchema,
    label: z.string(),
    excerpt: z.string().optional(),
    /** Source evidence only: true when the read commit's tree carried uncommitted changes. */
    dirty: z.boolean().optional(),
  })
  // `kind` must match the URI's kind: the renderer keys its icon off `kind`.
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
 * Model-facing input shape. The model cites bare ids and the executor
 * canonicalizes them into the strict schema above.
 */
const evidenceLabelShape = {
  label: z.string().describe('Short label, e.g. "run_abc123 failed span".'),
  excerpt: z.string().optional().describe("Optional verbatim snippet."),
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

/** One member, not seven: they differ only in the value of `kind`. */
export const simpleEvidenceRefSchema = z.object({
  kind: z.enum(SIMPLE_EVIDENCE_KINDS),
  uri: z
    .string()
    .min(1)
    .describe(
      "The id exactly as a tool returned it: a run id, error fingerprint, queue name, deployment version, or report key. A trigger:// URI of the same kind and environment also works."
    ),
  ...evidenceLabelShape,
});

export const spanEvidenceRefSchema = z.object({
  kind: z.literal("span"),
  runId: z.string().min(1).describe("The run it belongs to, e.g. run_abc123."),
  spanId: z.string().min(1).describe("As the trace returned it."),
  ...evidenceLabelShape,
});

export const sourceEvidenceRefSchema = z.object({
  kind: z.literal("source"),
  path: z
    .string()
    .min(1)
    .describe(
      'Repo-relative path of the file you read, e.g. "src/tasks/send-order-receipt.ts". Never a line suffix — the line goes in `line`.'
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
    .describe("The commit you read it at. Omit it and the executor pins this turn's snapshot."),
  ...evidenceLabelShape,
});

export const evidenceRefSchema = z.discriminatedUnion("kind", [
  simpleEvidenceRefSchema,
  spanEvidenceRefSchema,
  sourceEvidenceRefSchema,
]);

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type SourceEvidenceRef = z.infer<typeof sourceEvidenceRefSchema>;
export type SpanEvidenceRef = z.infer<typeof spanEvidenceRefSchema>;
