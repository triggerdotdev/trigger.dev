import type { AlertCapability } from "@internal/alert-contracts";
import { env } from "~/env.server";
import { filterOfferedCapabilities } from "./offeredCapabilities";

export function queueMetricsEnabled(): boolean {
  return env.QUEUE_METRICS_EMIT_ENABLED === "1" && env.QUEUE_METRICS_CONSUMER_ENABLED === "1";
}

export function offeredCapabilities<T extends Pick<AlertCapability, "area">>(caps: T[]): T[] {
  return filterOfferedCapabilities(caps, queueMetricsEnabled());
}
