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

// Electric SQL's shape-stream protocol adds a `handle=` query param on
// every reconnect after the initial GET. Gating the realtime-buffered
// log/counter on its absence keeps the signal at one tick per
// subscription instead of one tick per ~20s live-poll iteration —
// without it the counter would over-count by the long-poll factor.
export function isInitialBufferedSubscriptionRequest(url: string | URL): boolean {
  const u = typeof url === "string" ? new URL(url) : url;
  return !u.searchParams.has("handle");
}
