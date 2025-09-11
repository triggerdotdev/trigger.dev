import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type {
  PushMetricExporter,
  ResourceMetrics,
  MetricData,
  DataPoint,
  Histogram,
  ExponentialHistogram,
} from "@opentelemetry/sdk-metrics";

/**
 * Compact metric exporter that logs metrics in a single-line format
 * Similar to Prometheus text format for better readability
 */
export class CompactMetricExporter implements PushMetricExporter {
  /**
   * Export metrics in a compact format
   */
  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    try {
      this._exportMetrics(metrics);
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Shutdown the exporter
   */
  async shutdown(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Force flush any buffered data
   */
  async forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Process and log metrics in compact format
   */
  private _exportMetrics(resourceMetrics: ResourceMetrics): void {
    for (const scopeMetric of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetric.metrics) {
        this._exportMetric(metric);
      }
    }
  }

  /**
   * Export a single metric
   */
  private _exportMetric(metric: MetricData): void {
    const metricName = metric.descriptor.name;

    for (const dataPoint of metric.dataPoints) {
      const formattedLine = this._formatDataPoint(metricName, dataPoint);
      if (formattedLine) {
        console.log(formattedLine);
      }
    }
  }

  /**
   * Format a data point into a single line
   */
  private _formatDataPoint(
    metricName: string,
    dataPoint: DataPoint<number> | DataPoint<Histogram> | DataPoint<ExponentialHistogram>
  ): string | null {
    // Extract attributes/labels
    const labels = this._formatLabels(dataPoint.attributes);

    // Extract value based on data point type
    const value = this._extractValue(dataPoint);

    if (value === null || value === undefined) {
      return null;
    }

    // Format as: metric_name{label1="value1",label2="value2"} = value
    if (labels) {
      return `${metricName}{${labels}} = ${value}`;
    }

    return `${metricName} = ${value}`;
  }

  /**
   * Format attributes as Prometheus-style labels
   */
  private _formatLabels(attributes: Record<string, unknown>): string {
    const entries = Object.entries(attributes);
    if (entries.length === 0) {
      return "";
    }

    return entries.map(([key, value]) => `${key}="${String(value)}"`).join(",");
  }

  /**
   * Extract the numeric value from a data point
   */
  private _extractValue(
    dataPoint: DataPoint<number> | DataPoint<Histogram> | DataPoint<ExponentialHistogram>
  ): number | null {
    const value = dataPoint.value;

    // Check if value is a simple number (Gauge, Sum, UpDownSum)
    if (typeof value === "number") {
      return value;
    }

    // Check if value is a Histogram or ExponentialHistogram
    if (this._isHistogram(value) || this._isExponentialHistogram(value)) {
      return value.sum ?? null;
    }

    return null;
  }

  /**
   * Type guard for Histogram
   */
  private _isHistogram(value: unknown): value is Histogram {
    return (
      value !== null &&
      typeof value === "object" &&
      "sum" in value &&
      "count" in value &&
      "buckets" in value
    );
  }

  /**
   * Type guard for ExponentialHistogram
   */
  private _isExponentialHistogram(value: unknown): value is ExponentialHistogram {
    return (
      value !== null &&
      typeof value === "object" &&
      "sum" in value &&
      "count" in value &&
      "scale" in value
    );
  }
}
