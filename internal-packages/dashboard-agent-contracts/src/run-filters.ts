/**
 * The serializable subset of the runs-page filters the agent may carry: enough to
 * reproduce a runs list URL, nothing more. The webapp's `TaskRunListSearchFilters`
 * owns the URL params, but it pulls in webapp enums, so this is a loose
 * dependency-free mirror of the navigable fields.
 *
 * Every value is a string or string[], so it maps 1:1 onto URL search params and a
 * new run status never breaks a stored transcript. Pagination is excluded: a
 * cursor is not a filter and does not survive replay. Unknown keys are stripped on
 * parse, so a filter the host doesn't understand degrades to no filter.
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
  /** Absolute window bounds as ISO strings, which JSON round-trips cleanly. */
  from: z.string().optional(),
  to: z.string().optional(),
  /** Free-text run search (run id, task, tag). */
  search: z.string().optional(),
  rootOnly: z.boolean().optional(),
  batchId: z.string().optional(),
  scheduleId: z.string().optional(),
});

export type RunFilters = z.infer<typeof runFiltersSchema>;
