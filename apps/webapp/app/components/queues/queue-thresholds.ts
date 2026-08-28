/** Head-of-line wait at which a queue reads as stuck. Shared by the queue page and the watch card. */
export const OLDEST_WAIT_WARNING_MS = 5 * 60_000;

export type QueueCapacity = {
  running: number;
  queued: number;
  /** Effective limit: the queue's own, else the environment's. Null when neither is set. */
  limit: number | null | undefined;
};

/**
 * Saturation: the queue is running everything it is allowed to and still has a backlog.
 * A limit of 0 is zero capacity, not saturation — `running >= 0` holds for every queue, so
 * without the guard any backlog would read as saturated.
 */
export function isQueueAtCapacity({ running, queued, limit }: QueueCapacity): boolean {
  if (limit === null || limit === undefined || limit <= 0) return false;
  return running >= limit && queued > 0;
}

/** Whether the queue detail page offers Investigate. Paused is a state, not a fault. */
export function isQueueDegraded({
  paused,
  oldestWaitMs,
  ...capacity
}: QueueCapacity & {
  paused: boolean | null | undefined;
  oldestWaitMs: number | null | undefined;
}): boolean {
  if (paused) return false;
  if (isQueueAtCapacity(capacity)) return true;
  return (
    oldestWaitMs !== null && oldestWaitMs !== undefined && oldestWaitMs >= OLDEST_WAIT_WARNING_MS
  );
}
