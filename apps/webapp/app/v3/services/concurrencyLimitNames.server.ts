import { createHash } from "node:crypto";
import { sanitizeQueueName } from "~/models/taskQueue.server";

/** Queue rows that back named concurrency limits live under this reserved prefix so
 * they can never collide with a user's queue names. */
export const CONCURRENCY_LIMIT_QUEUE_PREFIX = "limit/";

/** Rows of tasks' anonymous inline limits. */
export const ANONYMOUS_LIMIT_PREFIX = `${CONCURRENCY_LIMIT_QUEUE_PREFIX}task/`;

/** A boundless anonymous inline limit; a retired limit and an active unbounded gate look the same. */
export const isUnlistedInlineLimit = (queue: {
  role: string;
  name: string;
  concurrencyLimit: number | null;
  totalConcurrencyLimit: number | null;
}) =>
  queue.role === "LIMIT" &&
  queue.name.startsWith(ANONYMOUS_LIMIT_PREFIX) &&
  queue.concurrencyLimit === null &&
  queue.totalConcurrencyLimit === null;

/**
 * Row name for a task's anonymous inline limit. Task ids are not charset-restricted,
 * so when sanitization would be lossy (or the name would overflow the 128-char queue
 * name limit) a hash of the raw id keeps distinct task ids on distinct rows. Lookup
 * by the public task/<task-id> name derives the row name with this same function.
 */
export function anonymousConcurrencyLimitQueueName(taskId: string): string {
  const sanitized = sanitizeQueueName(taskId);
  const name = `${CONCURRENCY_LIMIT_QUEUE_PREFIX}task/${sanitized}`;
  if (sanitized === taskId && name.length <= 128) {
    return name;
  }
  const hash = createHash("sha256").update(taskId).digest("hex").slice(0, 8);
  const budget = 128 - `${CONCURRENCY_LIMIT_QUEUE_PREFIX}task/`.length - hash.length - 1;
  return `${CONCURRENCY_LIMIT_QUEUE_PREFIX}task/${sanitized.slice(0, budget)}-${hash}`;
}
