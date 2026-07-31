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
 * The model-facing input shape of evidence.
 *
 * The strict schema above is what's persisted and rendered. The model can't
 * construct a canonical `trigger://` URI — the grammar embeds the environment
 * id, which the model never sees — so at the tool boundary it cites resources
 * by what the read tools gave it, and the executor (which has the project and
 * environment context) builds the canonical URI before anything is stored.
 *
 * A kind whose URI needs ONE bare id cites it as `uri`. The two kinds whose URI
 * needs more than one part carry those parts as named fields instead of being
 * squeezed into a string: a `span` names its run and span, and a `source` names
 * its path (plus the line, and the commit when it isn't the snapshot this turn
 * read). That's the whole point — a code-grounded cause has to survive the
 * boundary, and "src/foo.ts:12" in a single `uri` field can't be canonicalized.
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
