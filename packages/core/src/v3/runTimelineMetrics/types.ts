import { Attributes } from "@opentelemetry/api";

export type RunTimelineMetric = {
  name: string;
  event: string;
  timestamp: number;
  attributes?: Attributes;
};

export interface RunTimelineMetricsManager {
  registerMetric(metric: RunTimelineMetric): void;
  getMetrics(): RunTimelineMetric[];
}
