import {
  OtelCollectorContainer,
  type StartedOtelCollectorContainer,
} from "@internal/testcontainers";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import {
  AggregationTemporality,
  DataPointType,
  InstrumentType,
  type MetricData,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BufferingMetricExporter } from "./otelProcessors.js";

class RecordingMetricExporter implements PushMetricExporter {
  exported: ResourceMetrics[] = [];

  export(metrics: ResourceMetrics, resultCallback: (result: { code: number }) => void): void {
    this.exported.push(metrics);
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

function gauge(name: string, values: number[]): MetricData {
  return {
    descriptor: {
      name,
      description: "",
      unit: "1",
      type: InstrumentType.OBSERVABLE_GAUGE,
      valueType: 1,
    },
    aggregationTemporality: AggregationTemporality.CUMULATIVE,
    dataPointType: DataPointType.GAUGE,
    dataPoints: values.map((value) => ({
      attributes: { "process.cpu.state": "user" },
      startTime: [1786481102, 584000000],
      endTime: [1786481102, 698000000],
      value,
    })),
  } as MetricData;
}

function resourceMetrics(metrics: MetricData[]): ResourceMetrics {
  return {
    resource: { attributes: {} },
    scopeMetrics: [{ scope: { name: "@opentelemetry/host-metrics" }, metrics }],
  } as unknown as ResourceMetrics;
}

async function exportThrough(exporter: BufferingMetricExporter, metrics: ResourceMetrics) {
  exporter.export(metrics, () => {});
  await exporter.forceFlush();
}

function histogram(name: string, sums: number[]): MetricData {
  return {
    descriptor: {
      name,
      description: "",
      unit: "ms",
      type: InstrumentType.HISTOGRAM,
      valueType: 1,
    },
    aggregationTemporality: AggregationTemporality.DELTA,
    dataPointType: DataPointType.HISTOGRAM,
    dataPoints: sums.map((sum) => ({
      attributes: { "task.status": "completed" },
      startTime: [1786481102, 584000000],
      endTime: [1786481102, 698000000],
      value: {
        min: 0,
        max: 1,
        sum,
        count: 1,
        buckets: { boundaries: [0, 1], counts: [0, 1, 0] },
      },
    })),
  } as MetricData;
}

describe("BufferingMetricExporter", () => {
  it("forwards only the finite data points of a metric", async () => {
    const inner = new RecordingMetricExporter();
    const exporter = new BufferingMetricExporter(inner, 30_000);

    await exportThrough(exporter, resourceMetrics([gauge("process.cpu.utilization", [NaN, 0.25])]));

    const forwarded = inner.exported[0]!.scopeMetrics[0]!.metrics[0]!;
    expect(forwarded.dataPoints.map((dp) => dp.value)).toEqual([0.25]);
  });

  it("drops infinite data points as well as NaN", async () => {
    const inner = new RecordingMetricExporter();
    const exporter = new BufferingMetricExporter(inner, 30_000);

    await exportThrough(
      exporter,
      resourceMetrics([gauge("process.cpu.utilization", [Infinity, -Infinity, 0.5])])
    );

    const forwarded = inner.exported[0]!.scopeMetrics[0]!.metrics[0]!;
    expect(forwarded.dataPoints.map((dp) => dp.value)).toEqual([0.5]);
  });

  it("forwards only the histogram data points with a finite sum", async () => {
    const inner = new RecordingMetricExporter();
    const exporter = new BufferingMetricExporter(inner, 30_000);

    await exportThrough(exporter, resourceMetrics([histogram("task.duration", [NaN, 5])]));

    const forwarded = inner.exported[0]!.scopeMetrics[0]!.metrics[0]!;
    expect(forwarded.dataPoints.map((dp) => (dp.value as { sum: number }).sum)).toEqual([5]);
  });

  describe("against a real otel collector", () => {
    let collector: StartedOtelCollectorContainer;

    beforeAll(async () => {
      collector = await new OtelCollectorContainer().start();
    }, 180_000);

    afterAll(async () => {
      await collector?.stop();
    });

    it("exports a batch containing a NaN gauge value without being rejected", async () => {
      const exporter = new BufferingMetricExporter(
        new OTLPMetricExporter({ url: `${collector.getOtlpHttpUrl()}/v1/metrics` }),
        30_000
      );

      exporter.export(resourceMetrics([gauge("process.cpu.utilization", [NaN, 0.25])]), () => {});

      await expect(exporter.forceFlush()).resolves.toBeUndefined();
    });
  });
});
