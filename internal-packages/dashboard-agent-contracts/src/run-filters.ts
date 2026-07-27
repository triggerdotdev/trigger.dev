/**
 * The serializable subset of the runs-page filters the agent is allowed to carry
 * around: enough to reproduce a runs list URL, nothing more.
 *
 * The dashboard's own filter schema (`TaskRunListSearchFilters` in
 * apps/webapp/app/components/runs/v3/RunFilters.tsx) is the source of truth for
 * the URL params, but it lives in the webapp and pulls in webapp enums. This is a
 * deliberately loose, dependency-free mirror of the *navigable* fields:
 *
 * - every value is a string or string[] so it maps 1:1 onto URL search params;
 * - statuses/tasks/versions/tags stay plain strings (no webapp enum import), so a
 *   new run status never breaks a stored transcript;
 * - pagination (`cursor`, `direction`) is deliberately excluded — a cursor is not
 *   a filter and does not survive replay.
 *
 * Unknown keys are stripped on parse: a filter the host doesn't understand
 * degrades to "no filter" rather than to an error.
 */
import { z } from "zod";

const stringOrStringArray = z.union([z.string(), z.array(z.string())]).optional();

export const runFiltersSchema = z.object({
  tasks: stringOrStringArray,
  versions: stringOrStringArray,
  statuses: stringOrStringArray,
  tags: stringOrStringArray,
  queues: stringOrStringArray,
  /** Relative window shorthand, e.g. "1h", "24h", "7d". */
  period: z.string().optional(),
  /** Absolute window bounds as ISO strings (millisecond epochs don't survive JSON round-trips as cleanly). */
  from: z.string().optional(),
  to: z.string().optional(),
  /** Free-text run search (run id, task, tag). */
  search: z.string().optional(),
  rootOnly: z.boolean().optional(),
  batchId: z.string().optional(),
  scheduleId: z.string().optional(),
});

export type RunFilters = z.infer<typeof runFiltersSchema>;
