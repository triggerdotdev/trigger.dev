import type { Meter } from "@internal/tracing";
import type { DecoratorMetrics, SnapshotStoreMetrics } from "@internal/run-store";

export type SnapshotSweepCounts = Record<string, number | boolean>;

/**
 * Every instrument is created inside this function. At module scope they would register on every
 * boot, including deployments with no snapshot-store Redis configured.
 */
export function createSnapshotStoreMetrics(meter: Meter) {
  const appendTotal = meter.createCounter("run_engine.snapshot_store.append_total");
  const appendFailed = meter.createCounter("run_engine.snapshot_store.append_failed");
  const flushStaged = meter.createCounter("run_engine.snapshot_store.flush_staged");
  const readSource = meter.createCounter("run_engine.snapshot_store.read_source");
  const postExpiryWrite = meter.createCounter("run_engine.snapshot_store.post_expiry_write");
  const skippedNoKeyspace = meter.createCounter("run_engine.snapshot_store.skipped_no_keyspace");
  const cycleMismatch = meter.createCounter("run_engine.snapshot_store.cycle_mismatch");
  const entryBytes = meter.createHistogram("run_engine.snapshot_store.entry_bytes");
  const cycleKeyBytes = meter.createHistogram("run_engine.snapshot_store.cycle_key_bytes");
  const cycleCount = meter.createHistogram("run_engine.snapshot_store.cycle_count");
  const opLatency = meter.createHistogram("run_engine.snapshot_store.op_latency_ms");
  const sweepPass = meter.createCounter("run_engine.snapshot_store.sweep_pass_total");
  const sweepCounts = meter.createHistogram("run_engine.snapshot_store.sweep_counts");

  const store: SnapshotStoreMetrics = {
    recordAppend: (outcome, ttl) => appendTotal.add(1, { outcome, ttl }),
    recordEntryBytes: (bytes) => entryBytes.record(bytes),
    recordCycleKeyBytes: (bytes) => cycleKeyBytes.record(bytes),
    recordCycleCount: (count) => cycleCount.record(count),
    recordSkippedNoKeyspace: () => skippedNoKeyspace.add(1),
    recordCycleMismatch: () => cycleMismatch.add(1),
    recordLatency: (op, ms) => opLatency.record(ms, { op }),
  };

  const decorator: DecoratorMetrics = {
    recordWrite: (site, outcome) => {
      appendTotal.add(1, { site, outcome });
      if (outcome === "post_expiry") {
        postExpiryWrite.add(1);
      }
      if (outcome === "staged") {
        flushStaged.add(1);
      }
    },
    recordAppendFailed: (site) => appendFailed.add(1, { site }),
    recordRead: (method, source) => readSource.add(1, { method, source }),
  };

  /** One emitter per pass, so a pass that throws is distinguishable from one that succeeded. */
  function recordSweepPass(outcome: string, counts?: SnapshotSweepCounts): void {
    sweepPass.add(1, { outcome });
    if (!counts) {
      return;
    }
    for (const [field, value] of Object.entries(counts)) {
      if (typeof value === "number") {
        sweepCounts.record(value, { field });
      }
    }
  }

  return { store, decorator, recordSweepPass };
}
