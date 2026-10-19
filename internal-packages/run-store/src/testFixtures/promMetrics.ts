// Metric sinks backed by a real prom-client Registry, so a test asserts what the registry exports
// rather than how often a sink was called.
import { Counter, Gauge, Histogram, type Registry } from "prom-client";
import type { RecoveryMetrics } from "../pendingRecoveryWorker.js";
import type { SnapshotDecoratorMetrics } from "../taskRunExecutionSnapshotStore.js";

export function decoratorMetrics(register: Registry): SnapshotDecoratorMetrics {
  const writes = new Counter({
    name: "snapshot_store_writes_total",
    help: "Snapshot store transaction-sized writes by outcome",
    labelNames: ["outcome"],
    registers: [register],
  });
  const readSources = new Counter({
    name: "snapshot_store_read_source_total",
    help: "Snapshot store authoritative reads by source",
    labelNames: ["source"],
    registers: [register],
  });
  return {
    recordWrite: (outcome) => writes.inc({ outcome }),
    recordReadSource: (source) => readSources.inc({ source }),
  };
}

// The recovery sweep's sink, with the series the webapp registers for it.
export function recoveryMetrics(register: Registry): RecoveryMetrics {
  const registers = [register];
  const outcomes = new Counter({
    name: "snapshot_store_recovery_outcome_total",
    help: "Snapshot recovery sweep outcomes per pending unit.",
    labelNames: ["kind"],
    registers,
  });
  const routeUnavailable = new Counter({
    name: "snapshot_store_recovery_route_unavailable_total",
    help: "Pending units retried because their owning primary had no route.",
    registers,
  });
  const sweepLatency = new Histogram({
    name: "snapshot_store_recovery_sweep_seconds",
    help: "Snapshot recovery sweep tick duration.",
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
    registers,
  });
  const pendingCount = new Gauge({
    name: "snapshot_store_recovery_pending_count",
    help: "Unresolved prepared units across every pending partition.",
    registers,
  });
  const oldestPendingAge = new Gauge({
    name: "snapshot_store_recovery_oldest_pending_age_seconds",
    help: "Age of the oldest unresolved prepared unit.",
    registers,
  });
  return {
    recordOutcome: (kind) => outcomes.inc({ kind }),
    recordRouteUnavailable: () => routeUnavailable.inc(),
    recordSweepLatency: (ms) => sweepLatency.observe(ms / 1000),
    recordPending: (oldestAgeMs, count) => {
      oldestPendingAge.set(oldestAgeMs / 1000);
      pendingCount.set(count);
    },
  };
}

/**
 * The exported value of one series, or undefined when the registry has no such series. A histogram's
 * series are addressed by their exported names (`<name>_count`, `<name>_sum`, `<name>_bucket`).
 */
export async function metricValue(
  register: Registry,
  name: string,
  labels: Record<string, string> = {}
): Promise<number | undefined> {
  for (const metric of await register.getMetricsAsJSON()) {
    for (const series of metric.values) {
      const seriesName = (series as { metricName?: string }).metricName ?? metric.name;
      if (
        seriesName === name &&
        Object.entries(labels).every(([key, value]) => String(series.labels[key]) === value)
      ) {
        return series.value;
      }
    }
  }
  return undefined;
}
