import { TaskRunExecutionMetrics } from "../schemas/schemas.js";
import { getEnvVar } from "../utils/getEnv.js";
import { RunTimelineMetric, RunTimelineMetricsManager } from "./types.js";

export class StandardRunTimelineMetricsManager implements RunTimelineMetricsManager {
  private _metrics: RunTimelineMetric[] = [];

  registerMetric(metric: RunTimelineMetric): void {
    this._metrics.push(metric);
  }

  getMetrics(): RunTimelineMetric[] {
    return this._metrics;
  }

  registerMetricsFromExecution(metrics?: TaskRunExecutionMetrics): void {
    this.#seedMetricsFromEnvironment();

    if (metrics) {
      metrics.forEach((metric) => {
        this.registerMetric({
          name: `trigger.dev/${metric.name}`,
          event: metric.event,
          timestamp: metric.timestamp,
          attributes: {
            duration: metric.duration,
          },
        });
      });
    }
  }

  #seedMetricsFromEnvironment() {
    const forkStartTime = getEnvVar("TRIGGER_PROCESS_FORK_START_TIME");
    const warmStart = getEnvVar("TRIGGER_WARM_START");
    const isWarmStart = warmStart === "true";

    if (typeof forkStartTime === "string" && !isWarmStart) {
      const forkStartTimeMs = parseInt(forkStartTime, 10);

      this.registerMetric({
        name: "trigger.dev/start",
        event: "fork",
        attributes: {
          duration: Date.now() - forkStartTimeMs,
        },
        timestamp: forkStartTimeMs,
      });
    }
  }
}

export class NoopRunTimelineMetricsManager implements RunTimelineMetricsManager {
  registerMetric(metric: RunTimelineMetric): void {
    // Do nothing
  }

  getMetrics(): RunTimelineMetric[] {
    return [];
  }
}
