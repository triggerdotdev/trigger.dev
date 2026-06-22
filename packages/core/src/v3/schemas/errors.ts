import { z } from "zod";

/**
 * The lifecycle state of an error group. Mirrors the dashboard's
 * `ErrorGroupState.status` (`UNRESOLVED | RESOLVED | IGNORED`) but is exposed
 * lowercase over the API, matching the `filter[status]` query value.
 */
export const ErrorGroupStatus = z.enum(["unresolved", "resolved", "ignored"]);

export type ErrorGroupStatus = z.infer<typeof ErrorGroupStatus>;

/**
 * A single error group as returned by the list endpoint. `count` is the number
 * of occurrences within the requested time range; `firstSeen`/`lastSeen` are
 * the group's global first/last occurrence.
 */
export const ErrorGroupListItem = z.object({
  id: z.string(),
  fingerprint: z.string(),
  taskIdentifier: z.string(),
  errorType: z.string(),
  errorMessage: z.string(),
  status: ErrorGroupStatus,
  count: z.number(),
  firstSeen: z.coerce.date(),
  lastSeen: z.coerce.date(),
  resolvedAt: z.coerce.date().nullable(),
  ignoredUntil: z.coerce.date().nullable(),
});

export type ErrorGroupListItem = z.infer<typeof ErrorGroupListItem>;

export const ListErrorsResponse = z.object({
  data: z.array(ErrorGroupListItem),
  pagination: z.object({
    next: z.string().optional(),
    previous: z.string().optional(),
  }),
});

export type ListErrorsResponse = z.infer<typeof ListErrorsResponse>;

/**
 * The full detail for a single error group: summary fields, the affected task
 * versions (most recent five), and the complete lifecycle state.
 */
export const ErrorGroupDetail = z.object({
  id: z.string(),
  fingerprint: z.string(),
  taskIdentifier: z.string(),
  errorType: z.string(),
  errorMessage: z.string(),
  count: z.number(),
  firstSeen: z.coerce.date(),
  lastSeen: z.coerce.date(),
  affectedVersions: z.array(z.string()),
  status: ErrorGroupStatus,
  resolvedAt: z.coerce.date().nullable(),
  resolvedInVersion: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  ignoredAt: z.coerce.date().nullable(),
  ignoredUntil: z.coerce.date().nullable(),
  ignoredReason: z.string().nullable(),
  ignoredByUserId: z.string().nullable(),
  ignoredUntilOccurrenceRate: z.number().nullable(),
  ignoredUntilTotalOccurrences: z.number().nullable(),
});

export type ErrorGroupDetail = z.infer<typeof ErrorGroupDetail>;

export const ResolveErrorRequestBody = z.object({
  resolvedInVersion: z.string().optional(),
});

export type ResolveErrorRequestBody = z.infer<typeof ResolveErrorRequestBody>;

export const IgnoreErrorRequestBody = z.object({
  /** How long to ignore the error for, in milliseconds. */
  duration: z.number().int().positive().optional(),
  /** Re-surface the error if its occurrence rate exceeds this many per minute. */
  occurrenceRate: z.number().positive().optional(),
  /** Re-surface the error once it accrues this many new occurrences. */
  totalOccurrences: z.number().int().positive().optional(),
  reason: z.string().max(1000).optional(),
});

export type IgnoreErrorRequestBody = z.infer<typeof IgnoreErrorRequestBody>;
