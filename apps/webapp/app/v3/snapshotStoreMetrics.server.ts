import type { Meter } from "@internal/tracing";
import type { DecoratorMetrics, SnapshotStoreMetrics } from "@internal/run-store";

export type SnapshotSweepCounts = Record<string, number | boolean>;

// Metric attributes must be bounded: every one of these is a time series. The store and the
// decorator type their outcome strings loosely, so anything unrecognised collapses to "other"
// rather than minting a series.
const APPEND_OUTCOMES = ["written", "duplicate", "forked", "skippedNoKeyspace"] as const;
const APPEND_TTLS = ["none", "completion", "reapplied"] as const;
const WRITE_OUTCOMES = ["written", "staged", "post_expiry", "skipped", "failed"] as const;
const READ_SOURCES = ["redis", "postgres"] as const;
const SWEEP_OUTCOMES = [
  "completed",
  "partial",
  "skipped_locked",
  "failed",
  "unbound",
  "aborted",
] as const;
const SWEEP_FIELDS = [
  "scanned",
  "expired",
  "deleted",
  "skipped",
  "pendingDeletion",
  "nodes",
] as const;

const WRITE_SITES = [
  "createRun",
  "createCancelledRun",
  "completeAttemptSuccess",
  "expireRun",
  "expireParkedRun",
  "rescheduleRun",
  "lockRunToWorker",
  "createExecutionSnapshot",
  "runInTransaction",
] as const;
const READ_METHODS = [
  "findLatestExecutionSnapshot",
  "findExecutionSnapshot",
  "findManyExecutionSnapshots",
  "findSnapshotCompletedWaitpointIds",
  "findSnapshotCompletedWaitpointIdsWithPresence",
] as const;
const SNAPSHOT_OPS = [
  "append",
  "getById",
  "getLatest",
  "getSince",
  "getSinceCreatedAt",
  "getSnapshotWaitpointIds",
] as const;

function bounded(value: string, allowed: readonly string[]): string {
  return allowed.includes(value) ? value : "other";
}

/**
 * Every instrument is created inside this function. At module scope they would register on every
 * boot, including deployments with no snapshot-store Redis configured.
 */
export function createSnapshotStoreMetrics(meter: Meter) {
  // Two layers, two counters. Sharing one would count a single logical write twice and mix
  // {outcome, ttl} points with {site, outcome} points under one name, so no sum or grouping over it
  // would mean anything.
  const appendTotal = meter.createCounter("run_engine.snapshot_store.append_total");
  const writeTotal = meter.createCounter("run_engine.snapshot_store.write_total");
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
    recordAppend: (outcome, ttl) =>
      appendTotal.add(1, {
        outcome: bounded(outcome, APPEND_OUTCOMES),
        ttl: bounded(ttl, APPEND_TTLS),
      }),
    recordEntryBytes: (bytes) => entryBytes.record(bytes),
    recordCycleKeyBytes: (bytes) => cycleKeyBytes.record(bytes),
    recordCycleCount: (count) => cycleCount.record(count),
    recordSkippedNoKeyspace: () => skippedNoKeyspace.add(1),
    recordCycleMismatch: () => cycleMismatch.add(1),
    recordLatency: (op, ms) => opLatency.record(ms, { op: bounded(op, SNAPSHOT_OPS) }),
  };

  const decorator: DecoratorMetrics = {
    recordWrite: (site, outcome) => {
      writeTotal.add(1, {
        site: bounded(site, WRITE_SITES),
        outcome: bounded(outcome, WRITE_OUTCOMES),
      });
      if (outcome === "post_expiry") {
        postExpiryWrite.add(1);
      }
      if (outcome === "staged") {
        flushStaged.add(1);
      }
    },
    recordAppendFailed: (site) => appendFailed.add(1, { site: bounded(site, WRITE_SITES) }),
    recordRead: (method, source) =>
      readSource.add(1, {
        method: bounded(method, READ_METHODS),
        source: bounded(source, READ_SOURCES),
      }),
  };

  /** One emitter per pass, so a pass that throws is distinguishable from one that succeeded. */
  function recordSweepPass(outcome: string, counts?: SnapshotSweepCounts): void {
    sweepPass.add(1, { outcome: bounded(outcome, SWEEP_OUTCOMES) });
    if (!counts) {
      return;
    }
    for (const [field, value] of Object.entries(counts)) {
      if (typeof value === "number" && SWEEP_FIELDS.includes(field as never)) {
        sweepCounts.record(value, { field });
      }
    }
  }

  return { store, decorator, recordSweepPass };
}
