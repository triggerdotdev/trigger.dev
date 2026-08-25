/**
 * Counters the routing store emits. Injected the same way RedisSnapshotStore takes its metrics,
 * so the package stays free of a metrics dependency and a test can assert on a fake.
 *
 * runops_shard_duplicate_id_total       — one id returned by two shards that should be disjoint
 * runops_waitpoint_probe_fallback_total — a waitpoint was not on the store its id named
 */
export type RoutingStoreMetrics = {
  recordDuplicateId(shardKeys: string[]): void;
  recordWaitpointProbeFallback(from: string, to: string): void;
};

export const noopRoutingStoreMetrics: RoutingStoreMetrics = {
  recordDuplicateId() {},
  recordWaitpointProbeFallback() {},
};
