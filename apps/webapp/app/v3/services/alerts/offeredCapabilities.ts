import type { AlertCapability } from "@internal/alert-contracts";

export function filterOfferedCapabilities<T extends Pick<AlertCapability, "area">>(
  caps: T[],
  queueMetricsEnabled: boolean
): T[] {
  return queueMetricsEnabled ? caps : caps.filter((c) => c.area !== "queues");
}
