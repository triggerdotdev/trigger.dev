import { getMeter } from "@internal/tracing";

const meter = getMeter("mollifier");

export const mollifierDecisionsCounter = meter.createCounter("mollifier.decisions", {
  description: "Count of mollifier gate decisions by outcome",
});

export type DecisionOutcome = "pass_through" | "shadow_log" | "mollify";

export function recordDecision(outcome: DecisionOutcome, reason?: string): void {
  mollifierDecisionsCounter.add(1, {
    outcome,
    ...(reason ? { reason } : {}),
  });
}
