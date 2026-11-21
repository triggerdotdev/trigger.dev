/**
 * The wait before each retry, without the random spread (`calculateNextRetryDelay`): the first
 * `limit` of them and how many more there are. A task's `maxAttempts` has no upper bound, so only
 * the waits that get shown are worked out.
 */
export function retryWaits({
  maxAttempts,
  factor,
  min,
  max,
  limit,
}: {
  maxAttempts: number;
  factor: number;
  min: number;
  max: number;
  /** The most waits to work out. */
  limit: number;
}): { shown: number[]; more: number } {
  const total = Math.max(0, Math.floor(maxAttempts) - 1);
  const count = Math.min(total, limit);
  return {
    shown: Array.from({ length: count }, (_, index) =>
      Math.round(Math.min(max, min * Math.pow(factor, index)))
    ),
    more: total - count,
  };
}
