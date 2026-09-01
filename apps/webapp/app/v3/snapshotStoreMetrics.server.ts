import type { Meter } from "@internal/tracing";
import { APPEND_RESULT_OUTCOMES } from "@internal/run-store";
import type { DecoratorMetrics, SnapshotStoreMetrics } from "@internal/run-store";
import { cohortMetricLabel } from "./cohortMetricLabel.server";

// Metric attributes must be bounded: every one of these is a time series. The store and the
// decorator type their outcome strings loosely, so anything unrecognised collapses to "other"
// rather than minting a series.
const APPEND_OUTCOMES = ["written", "duplicate", "forked", "skippedNoKeyspace"] as const;
const APPEND_TTLS = ["none", "completion", "reapplied"] as const;
/** Derived from the store's own vocabulary, so an added outcome cannot silently become "other". */
export const WRITE_OUTCOMES = APPEND_RESULT_OUTCOMES;
const READ_SOURCES = ["redis", "postgres"] as const;
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
  // The repair's own writes. Without this they collapse to "other", so the one number that says
  // whether the repair works is missing, and a repair racing a live transition is indistinguishable
  // from a real divergence on the fork alert.
  "repairRedisHead",
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
/** Exported so the paging rule for a forked append is written against the real name. */
export const SNAPSHOT_STORE_WRITE_TOTAL = "run_engine.snapshot_store.write_total";

// The soak cohort predicate. Task 9 wires the real org-mode source in; until then everyone is
// "other", so the per-org label mints no series.
export function createSnapshotStoreMetrics(
  meter: Meter,
  isCohortMember: (organizationId: string) => boolean = () => false
) {
  // Two layers, two counters. Sharing one would count a single logical write twice and mix
  // {outcome, ttl} points with {site, outcome} points under one name, so no sum or grouping over it
  // would mean anything.
  const appendTotal = meter.createCounter("run_engine.snapshot_store.append_total");
  const writeTotal = meter.createCounter(SNAPSHOT_STORE_WRITE_TOTAL);
  const appendFailed = meter.createCounter("run_engine.snapshot_store.append_failed");
  const readSource = meter.createCounter("run_engine.snapshot_store.read_source");
  const skippedNoKeyspace = meter.createCounter("run_engine.snapshot_store.skipped_no_keyspace");
  const cycleMismatch = meter.createCounter("run_engine.snapshot_store.cycle_mismatch");
  const entryBytes = meter.createHistogram("run_engine.snapshot_store.entry_bytes");
  const cycleKeyBytes = meter.createHistogram("run_engine.snapshot_store.cycle_key_bytes");
  const cycleCount = meter.createHistogram("run_engine.snapshot_store.cycle_count");
  const opLatency = meter.createHistogram("run_engine.snapshot_store.op_latency_ms");

  const store: SnapshotStoreMetrics = {
    recordAppend: (outcome, ttl, organizationId) =>
      appendTotal.add(1, {
        outcome: bounded(outcome, APPEND_OUTCOMES),
        ttl: bounded(ttl, APPEND_TTLS),
        org: cohortMetricLabel(organizationId, isCohortMember),
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
    },
    recordAppendFailed: (site, organizationId) =>
      appendFailed.add(1, {
        site: bounded(site, WRITE_SITES),
        org: cohortMetricLabel(organizationId, isCohortMember),
      }),
    recordRead: (method, source) =>
      readSource.add(1, {
        method: bounded(method, READ_METHODS),
        // NOT `source`. Every exported series already carries a `source` label describing the
        // telemetry pipeline, and a data point that repeats the name is dropped, so the whole
        // metric was silently absent while the counter was being incremented.
        served_by: bounded(source, READ_SOURCES),
      }),
  };

  // No sweep emitter here. The engine owns the sweep metrics, because the engine is what schedules
  // and runs a pass: see snapshotSweepPassCounter and snapshotSweepCountsHistogram. A second
  // emitter on this side was dead, and its field list had already drifted from the engine's.
  return { store, decorator };
}
