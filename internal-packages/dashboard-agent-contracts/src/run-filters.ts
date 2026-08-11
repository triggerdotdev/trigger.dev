/**
 * Dependency-free mirror of the webapp's `TaskRunListSearchFilters`. Values stay
 * strings so they map 1:1 onto URL search params; pagination is excluded.
 */
import { z } from "zod";

const stringOrStringArray = z.union([z.string(), z.array(z.string())]).optional();

export const runFiltersSchema = z.object({
  tasks: stringOrStringArray,
  versions: stringOrStringArray,
  statuses: stringOrStringArray.describe(
    "Run statuses as the dashboard names them: PENDING_VERSION, DELAYED, PENDING, DEQUEUED, EXECUTING, WAITING_TO_RESUME, COMPLETED_SUCCESSFULLY, COMPLETED_WITH_ERRORS, TIMED_OUT, CRASHED, SYSTEM_FAILURE, CANCELED, EXPIRED. FAILED is accepted as shorthand for any failing status; anything else is ignored."
  ),
  tags: stringOrStringArray,
  queues: stringOrStringArray,
  /** Relative window shorthand, e.g. "1h", "24h", "7d". */
  period: z.string().optional(),
  /** Absolute window bounds as ISO strings. */
  from: z.string().optional(),
  to: z.string().optional(),
  rootOnly: z.boolean().optional(),
  batchId: z.string().optional(),
  scheduleId: z.string().optional(),
});

export type RunFilters = z.infer<typeof runFiltersSchema>;
