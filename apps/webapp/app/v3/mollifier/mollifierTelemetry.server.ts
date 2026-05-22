import { getMeter } from "@internal/tracing";

const meter = getMeter("mollifier");

export const mollifierDecisionsCounter = meter.createCounter("mollifier.decisions", {
  description: "Count of mollifier gate decisions by outcome",
});

export type DecisionOutcome = "pass_through" | "shadow_log" | "mollify";
export type DecisionReason = "per_env_rate";

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

export function recordRealtimeBufferedSubscription(envId: string): void {
  realtimeBufferedSubscriptionsCounter.add(1, { envId });
}

// Counts buffer entries that have been waiting in the queue ZSET longer
// than the configured stale threshold (typically half of entryTtlSeconds).
// Useful for historical "stale events over time" views, but not directly
// alertable on its own — a single stuck entry observed by N sweep ticks
// adds N to the counter, so `rate()` over an alerting window reflects
// (entries × ticks), not "entries that are stale right now".
export const staleEntriesCounter = meter.createCounter(
  "mollifier.stale_entries",
  {
    description:
      "Mollifier buffer entries whose dwell exceeds the stale threshold (per sweep pass)",
  },
);

export function recordStaleEntry(envId: string): void {
  staleEntriesCounter.add(1, { envId });
}

// Alertable signal: the count of stale entries observed by the latest
// sweep, per env. The sweep snapshots the full per-env picture on each
// pass (including zeros for envs that no longer have any stale entries)
// so an env that was paging can clear when the drainer catches up
// instead of staying latched. Recommended alert:
//   mollifier_stale_entries_current{envId=...} > 0 for 5m
export const staleEntriesGauge = meter.createObservableGauge(
  "mollifier.stale_entries.current",
  {
    description:
      "Buffer entries whose dwell exceeds the stale threshold, as observed by the latest sweep pass",
  },
);

const latestStaleSnapshot = new Map<string, number>();

export function reportStaleEntrySnapshot(snapshot: Map<string, number>): void {
  // Replace, don't merge — envs absent from the new snapshot have either
  // drained or no longer exist; leaving their last value cached would
  // keep alerts latched forever.
  latestStaleSnapshot.clear();
  for (const [envId, count] of snapshot) {
    latestStaleSnapshot.set(envId, count);
  }
}

meter.addBatchObservableCallback(
  (result) => {
    for (const [envId, count] of latestStaleSnapshot) {
      result.observe(staleEntriesGauge, count, { envId });
    }
  },
  [staleEntriesGauge],
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
