import { getMeter } from "@internal/tracing";

const meter = getMeter("mollifier");

export const mollifierDecisionsCounter = meter.createCounter("mollifier.decisions", {
  description: "Count of mollifier gate decisions by outcome",
});

export type DecisionOutcome = "pass_through" | "shadow_log" | "mollify";
export type DecisionReason = "per_env_rate" | "global_rate";

export function recordDecision(outcome: DecisionOutcome, reason?: DecisionReason): void {
  mollifierDecisionsCounter.add(1, {
    outcome,
    ...(reason ? { reason } : {}),
  });
}

// Counts subscriptions hitting `/realtime/v1/runs/<id>` for a run that
// lives only in the mollifier buffer (no PG row yet). The route opens
// the Electric stream anyway so the eventual drainer-INSERT propagates
// to the client; this counter is the signal of how often customers
// subscribe inside the buffered window.
export const realtimeBufferedSubscriptionsCounter = meter.createCounter(
  "mollifier.realtime_subscriptions.buffered",
  {
    description:
      "Realtime subscriptions opened against a runId that exists only in the mollifier buffer",
  },
);

// No `envId` attribute — `envId` is a banned high-cardinality metric
// label per the repo's OTel rules. The structured warn log emitted
// alongside the counter tick (in `mollifierStaleSweep.server.ts`)
// carries the envId / orgId / runId for forensic drill-down; the
// metric stays an aggregate.
export function recordRealtimeBufferedSubscription(): void {
  realtimeBufferedSubscriptionsCounter.add(1);
}

// Counts buffer entries that have been waiting in the queue ZSET longer
// than the configured stale threshold. Useful for historical "stale
// events over time" views, but not directly alertable on its own — a
// single stuck entry observed by N sweep ticks adds N to the counter,
// so `rate()` over an alerting window reflects (entries × ticks), not
// "entries that are stale right now".
export const staleEntriesCounter = meter.createCounter(
  "mollifier.stale_entries",
  {
    description:
      "Mollifier buffer entries whose dwell exceeds the stale threshold (per sweep pass)",
  },
);

// No `envId` attribute — see comment above.
export function recordStaleEntry(): void {
  staleEntriesCounter.add(1);
}

// Alertable signal: the total count of stale entries observed by the
// latest sweep. The sweep snapshots the full picture on each pass so
// the gauge drops back to 0 when the drainer catches up instead of
// staying latched. Recommended alert:
//   mollifier_stale_entries_current > 0 for 5m
export const staleEntriesGauge = meter.createObservableGauge(
  "mollifier.stale_entries.current",
  {
    description:
      "Buffer entries whose dwell exceeds the stale threshold, as observed by the latest sweep pass",
  },
);

let latestStaleTotal = 0;

export function reportStaleEntrySnapshot(snapshot: Map<string, number>): void {
  // Sum across envs. Per-env breakdown is intentionally NOT emitted as
  // a metric label (high-cardinality); the structured warn log lines
  // from the sweep carry per-env detail for ops to drill down.
  let total = 0;
  for (const count of snapshot.values()) {
    total += count;
  }
  latestStaleTotal = total;
}

meter.addBatchObservableCallback(
  (result) => {
    result.observe(staleEntriesGauge, latestStaleTotal);
  },
  [staleEntriesGauge],
);

// Observability gauge for entries currently in DRAINING state — popped
// by the drainer but not yet acked/failed/requeued. Backed by the
// `mollifier:draining` ZSET (see `MollifierBuffer.getDrainingCount`)
// and polled by the loop in `mollifierDrainingGaugeLoop.server.ts`.
//
// Useful for:
//   - "Is anything mid-drain right now?" panels
//   - Post-crash forensics ("how many entries got stranded by that ECS OOM?")
//   - Alerting: a sustained non-zero with no drainer progress is a stall
//
// No `envId` attribute — same high-cardinality constraint as the other
// mollifier gauges. The per-entry hash carries env/org for drill-down.
export const drainingCountGauge = meter.createObservableGauge(
  "mollifier.draining.current",
  {
    description:
      "Mollifier buffer entries currently in DRAINING state (popped but not yet acked/failed/requeued)",
  },
);

let latestDrainingCount = 0;

export function reportDrainingCount(count: number): void {
  latestDrainingCount = count;
}

meter.addBatchObservableCallback(
  (result) => {
    result.observe(drainingCountGauge, latestDrainingCount);
  },
  [drainingCountGauge],
);

// Electric SQL's shape-stream protocol adds a `handle=` query param on
// every reconnect after the initial GET. Gating the realtime-buffered
// log/counter on its absence keeps the signal at one tick per
// subscription instead of one tick per ~20s live-poll iteration —
// without it the counter would over-count by the long-poll factor.
export function isInitialBufferedSubscriptionRequest(url: string | URL): boolean {
  const u = typeof url === "string" ? new URL(url) : url;
  return !u.searchParams.has("handle");
}
