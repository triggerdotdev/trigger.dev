/**
 * Dashboard-only view of a queue row's configured bounds. The public QueueItem
 * shape is version-discriminated (V2 queues carry no queue-level concurrency),
 * but the dashboard shows configured limits for every row, so presenters attach
 * this alongside the public fields.
 */
export type QueueLimitBound = {
  /** The enforced value right now (declared, or the override when one is active) */
  current: number | null;
  /** The declared value an override reverts to */
  base: number | null;
  /** The overridden value, when an override is active */
  override: number | null;
  overriddenAt: Date | null;
  /** Display name of who applied the override (null when via the API) */
  overriddenBy: string | null;
};

export type QueueTotalBound = {
  current: number;
  base: number | null;
  override: number | null;
  overriddenAt: Date | null;
  /** Runs in flight across every pool of the row (keyed and keyless) */
  running: number | null;
};

export type QueueLimits = {
  perKey: QueueLimitBound;
  /** Null when the row declares no total bound */
  total: QueueTotalBound | null;
};
