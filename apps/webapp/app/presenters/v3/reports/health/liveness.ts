/** Liveness analyzer: freshest-telemetry age. A null age is unknown, never a warning. */

import { type Finding, type Metric } from "../report-view-model";
import { metricById, type HealthInput } from "./health-core";

export function interpretLiveness(metrics: Metric[], input: HealthInput): Finding {
  const liveness = metricById(metrics, "liveness");
  const unknown = input.liveness.telemetryAgeMs === null;
  const reason = unknown
    ? "freshness_unknown"
    : liveness.severity === "ok"
      ? "fresh"
      : liveness.severity === "warn"
        ? "lagging"
        : "stale";
  return {
    type: "liveness",
    severity: liveness.severity,
    reason,
    metricIds: ["liveness"],
    recommendation:
      liveness.severity === "crit" ? { code: "check_control_plane", link: "status" } : undefined,
  };
}
