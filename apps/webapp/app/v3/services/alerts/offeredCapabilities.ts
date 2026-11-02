import type { AlertCapability } from "@internal/alert-contracts";

export const QUEUE_METRIC_LIMITS = ["limits.concurrency", "limits.queue"];

export function filterOfferedCapabilities<T extends Pick<AlertCapability, "area" | "key">>(
  caps: T[],
  queueMetricsEnabled: boolean
): T[] {
  return queueMetricsEnabled
    ? caps
    : caps.filter((c) => c.area !== "queues" && !QUEUE_METRIC_LIMITS.includes(c.key));
}
