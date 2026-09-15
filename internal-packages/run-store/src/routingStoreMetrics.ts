/**
 * Counters the routing store emits. Injected the same way RedisSnapshotStore takes its metrics,
 * so the package stays free of a metrics dependency and a test can assert on a fake.
 *
 * runops_shard_duplicate_id_total       — one id returned by two shards that should be disjoint
 * runops_waitpoint_probe_fallback_total — a waitpoint was not on the store its id named
 * runops_shard_routed_total             — an operation was routed to a shard, labelled by key
 */
export type RoutingStoreMetrics = {
  recordDuplicateId(shardKeys: string[]): void;
  recordWaitpointProbeFallback(from: string, to: string): void;
  /**
   * Every routed operation, keyed by the shard it landed on — the only per-shard series the
   * router emits, and what makes a cohort ramp visible while it is happening rather than after.
   * On the hot path, so an implementation must not build a label object per call.
   */
  recordShardRouted(shardKey: string): void;
};

export const noopRoutingStoreMetrics: RoutingStoreMetrics = {
  recordDuplicateId() {},
  recordWaitpointProbeFallback() {},
  recordShardRouted() {},
};
