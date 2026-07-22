import type { createInMemoryMetrics } from "./utils/tracing";

type MetricsHelper = ReturnType<typeof createInMemoryMetrics>;

// With cumulative temporality the latest export carries running totals for every instrument.
export async function latestMetrics(helper: MetricsHelper) {
  const all = await helper.getMetrics();
  return all[all.length - 1];
}

export function findMetric(resourceMetrics: any, name: string): any | undefined {
  if (!resourceMetrics) return undefined;
  for (const scopeMetrics of resourceMetrics.scopeMetrics) {
    for (const metric of scopeMetrics.metrics) {
      if (metric.descriptor.name === name) return metric;
    }
  }
  return undefined;
}

function pointValue(dp: any): number {
  const value = dp.value;
  if (typeof value === "number") return value;
  // Histogram / ExponentialHistogram data point
  return value?.sum ?? 0;
}

function matches(dp: any, attrs?: Record<string, string>): boolean {
  if (!attrs) return true;
  return Object.entries(attrs).every(([k, v]) => String(dp.attributes?.[k]) === v);
}

export function metricSum(
  resourceMetrics: any,
  name: string,
  attrs?: Record<string, string>
): number {
  const metric = findMetric(resourceMetrics, name);
  if (!metric) return 0;
  return metric.dataPoints
    .filter((dp: any) => matches(dp, attrs))
    .reduce((acc: number, dp: any) => acc + pointValue(dp), 0);
}

export function histogramCount(
  resourceMetrics: any,
  name: string,
  attrs?: Record<string, string>
): number {
  const metric = findMetric(resourceMetrics, name);
  if (!metric) return 0;
  return metric.dataPoints
    .filter((dp: any) => matches(dp, attrs))
    .reduce((acc: number, dp: any) => acc + (dp.value?.count ?? 0), 0);
}

export function gaugeValue(
  resourceMetrics: any,
  name: string,
  attrs?: Record<string, string>
): number | undefined {
  const metric = findMetric(resourceMetrics, name);
  if (!metric) return undefined;
  const points = metric.dataPoints.filter((dp: any) => matches(dp, attrs));
  if (points.length === 0) return undefined;
  return Math.max(...points.map((dp: any) => pointValue(dp)));
}
