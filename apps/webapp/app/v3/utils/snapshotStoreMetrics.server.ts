import { Counter, Histogram, type Registry, type RegistryContentType } from "prom-client";
import type { SnapshotDecoratorMetrics, SnapshotStoreMetrics } from "@internal/run-store";

/** Aggregate instruments only. No tenant/run IDs or per-org series. */
export function createSnapshotStoreMetrics(register: Registry<RegistryContentType>) {
  const registers = [register];
  const writes = new Counter({
    name: "snapshot_store_write_total",
    help: "Transaction-sized snapshot writes.",
    labelNames: ["outcome"],
    registers,
  });
  const reads = new Counter({
    name: "snapshot_store_read_total",
    help: "Authoritative snapshot read source.",
    labelNames: ["source"],
    registers,
  });
  const append = new Counter({
    name: "snapshot_store_append_total",
    help: "Snapshot entry append results.",
    labelNames: ["outcome", "ttl"],
    registers,
  });
  const latency = new Histogram({
    name: "snapshot_store_operation_seconds",
    help: "Snapshot Redis operation latency.",
    labelNames: ["operation"],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    registers,
  });
  const sizes = new Histogram({
    name: "snapshot_store_payload_bytes",
    help: "Snapshot entry and waitpoint payload sizes.",
    labelNames: ["kind"],
    buckets: [256, 1024, 4096, 16384, 65536, 262144, 1048576],
    registers,
  });
  const anomalies = new Counter({
    name: "snapshot_store_anomaly_total",
    help: "Snapshot state anomalies.",
    labelNames: ["kind"],
    registers,
  });
  const cycles = new Histogram({
    name: "snapshot_store_cycle_count",
    help: "Completed waitpoint cycles per run.",
    buckets: [1, 5, 10, 50, 100, 500, 1000],
    registers,
  });
  const decorator: SnapshotDecoratorMetrics = {
    recordWrite: (outcome) => writes.inc({ outcome }),
    recordReadSource: (source) => reads.inc({ source }),
  };
  const store: SnapshotStoreMetrics = {
    recordAppend: (outcome, ttl) => append.inc({ outcome, ttl }),
    recordEntryBytes: (bytes) => sizes.observe({ kind: "entry" }, bytes),
    recordCycleKeyBytes: (bytes) => sizes.observe({ kind: "cycle" }, bytes),
    recordCycleCount: (count) => cycles.observe(count),
    recordSkippedNoKeyspace: () => anomalies.inc({ kind: "missing-keyspace" }),
    recordCycleMismatch: () => anomalies.inc({ kind: "cycle-mismatch" }),
    recordLatency: (operation, ms) => latency.observe({ operation }, ms / 1000),
  };
  return { decorator, store };
}
