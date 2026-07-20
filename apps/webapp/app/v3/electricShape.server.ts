import { z } from "zod";

/**
 * OTel trace IDs are 32 lowercase hex chars. The traceparent parser only
 * checks the dash-delimited format, so crafted ids can be persisted and later
 * interpolated into shape `where` clauses. Validate here to close the SQLi vector.
 */
export const OtelTraceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, "traceId must be 32 lowercase hex characters");

/** Params the sync routes set themselves; stripped from incoming requests. */
export const RESERVED_ELECTRIC_SHAPE_PARAMS = new Set(["where", "table", "columns"]);

const CUID_LIKE = /^[a-z][a-z0-9_]*$/i;

/**
 * Tenant column a trace shape is scoped by. TaskEvent scopes by non-null
 * organizationId; TaskRun scopes by non-null projectId (its organizationId is
 * nullable). The column is from this fixed union, never user input, so it's
 * safe to interpolate.
 */
export type TraceScope =
  | { column: "organizationId"; id: string }
  | { column: "projectId"; id: string };

/**
 * Build the Electric Shape `where` clause for the trace sync routes. Both ids
 * are re-validated as defense-in-depth so a missed call site can't bypass scope.
 */
export function buildElectricTraceWhereClause(args: {
  traceId: string;
  scope: TraceScope;
}): string {
  const { traceId, scope } = args;
  if (!OtelTraceIdSchema.safeParse(traceId).success) {
    throw new Error("buildElectricTraceWhereClause: unsafe traceId");
  }
  if (!CUID_LIKE.test(scope.id)) {
    throw new Error("buildElectricTraceWhereClause: unsafe scope id");
  }
  return `"traceId"='${traceId}' AND "${scope.column}"='${scope.id}'`;
}

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
export function sanitizeRealtimeTagForSql(tag: string): string {
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
