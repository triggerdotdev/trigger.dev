import {
  OtelCollectorContainer,
  type StartedOtelCollectorContainer,
} from "@internal/testcontainers";

import { metrics } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import {
  MetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TracingSDK } from "./tracingSDK.js";

class NoopMetricExporter implements PushMetricExporter {
  forceFlushCount = 0;

  export(_metrics: ResourceMetrics, resultCallback: (result: { code: number }) => void): void {
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  async forceFlush(): Promise<void> {
    this.forceFlushCount++;
  }

  async shutdown(): Promise<void> {}
}

describe("TracingSDK with an external metric exporter", () => {
  let collector: StartedOtelCollectorContainer;
  let tracingSDK: TracingSDK;

  beforeAll(async () => {
    collector = await new OtelCollectorContainer().start();

    process.env.TRIGGER_OTEL_METRICS_COLLECTION_INTERVAL_MILLIS = "600000";

    tracingSDK = new TracingSDK({
      url: collector.getOtlpHttpUrl(),
      forceFlushTimeoutMillis: 30_000,
      diagLogLevel: "none",
      metricExporters: [new NoopMetricExporter()],
      hostMetrics: true,
      hostMetricGroups: ["process.cpu", "process.memory"],
      nodejsRuntimeMetrics: true,
    });
  }, 180_000);

  afterAll(async () => {
    await tracingSDK?.shutdown();
    await collector?.stop();
    delete process.env.TRIGGER_OTEL_METRICS_COLLECTION_INTERVAL_MILLIS;
  });

  it("flushes without the collector rejecting a batch containing a NaN reading", async () => {
    const gauge = metrics.getMeter("test").createObservableGauge("test.utilization");
    gauge.addCallback((result) => result.observe(NaN));

    await expect(tracingSDK.flush()).resolves.toBeUndefined();
  });

  it("collects from each metric reader one at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const gauge = metrics.getMeter("test").createObservableGauge("test.concurrency");
    gauge.addCallback(async (result) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      result.observe(1);
      inFlight--;
    });

    await tracingSDK.flush();

    expect(maxInFlight).toBe(1);
  });
});

class FailingMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {
    throw new Error("reader flush failed");
  }

  protected async onShutdown(): Promise<void> {}
}

class FailingShutdownMetricReader extends MetricReader {
  shutdownAttempts = 0;

  protected async onForceFlush(): Promise<void> {}

  protected async onShutdown(): Promise<void> {
    this.shutdownAttempts++;
    throw new Error(`reader shutdown failed (attempt ${this.shutdownAttempts})`);
  }
}

class RecordingMetricReader extends MetricReader {
  forceFlushCount = 0;
  shutdownCount = 0;

  protected async onForceFlush(): Promise<void> {
    this.forceFlushCount++;
  }

  protected async onShutdown(): Promise<void> {
    this.shutdownCount++;
  }
}

function captureConsoleErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;

  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  return { lines, restore: () => (console.error = original) };
}

describe("TracingSDK when one metric reader fails to flush", () => {
  let recordingReader: RecordingMetricReader;
  let tracingSDK: TracingSDK;

  beforeAll(() => {
    recordingReader = new RecordingMetricReader();

    tracingSDK = new TracingSDK({
      url: "http://localhost:1",
      forceFlushTimeoutMillis: 5_000,
      diagLogLevel: "none",
      metricReaders: [new FailingMetricReader(), recordingReader],
    });
  });

  it("still flushes the readers after it", async () => {
    await tracingSDK.flush().catch(() => {});

    expect(recordingReader.forceFlushCount).toBeGreaterThan(0);
  });

  it("still reports the failure to the caller", async () => {
    await expect(tracingSDK.flush()).rejects.toThrow("reader flush failed");
  });

  it("logs the failure as it happens", async () => {
    const console = captureConsoleErrors();

    await tracingSDK.flush().catch(() => {});
    console.restore();

    expect(console.lines.join("\n")).toContain("reader flush failed");
  });
});

class OverlapRecordingMetricReader extends MetricReader {
  static inFlight = 0;
  static maxInFlight = 0;

  protected async onForceFlush(): Promise<void> {}

  protected async onShutdown(): Promise<void> {
    OverlapRecordingMetricReader.inFlight++;
    OverlapRecordingMetricReader.maxInFlight = Math.max(
      OverlapRecordingMetricReader.maxInFlight,
      OverlapRecordingMetricReader.inFlight
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    OverlapRecordingMetricReader.inFlight--;
  }
}

describe("TracingSDK shutdown", () => {
  it("shuts down each metric reader one at a time", async () => {
    OverlapRecordingMetricReader.inFlight = 0;
    OverlapRecordingMetricReader.maxInFlight = 0;

    const tracingSDK = new TracingSDK({
      url: "http://localhost:1",
      forceFlushTimeoutMillis: 5_000,
      diagLogLevel: "none",
      metricReaders: [new OverlapRecordingMetricReader(), new OverlapRecordingMetricReader()],
    });

    await tracingSDK.shutdown().catch(() => {});

    expect(OverlapRecordingMetricReader.maxInFlight).toBe(1);
  });

  it("still shuts down the readers after one that fails", async () => {
    const recordingReader = new RecordingMetricReader();

    const tracingSDK = new TracingSDK({
      url: "http://localhost:1",
      forceFlushTimeoutMillis: 5_000,
      diagLogLevel: "none",
      metricReaders: [new FailingShutdownMetricReader(), recordingReader],
    });

    await tracingSDK.shutdown().catch(() => {});

    expect(recordingReader.shutdownCount).toBeGreaterThan(0);
  });

  it("does not retry a metric reader that failed to shut down", async () => {
    const failingReader = new FailingShutdownMetricReader();

    const tracingSDK = new TracingSDK({
      url: "http://localhost:1",
      forceFlushTimeoutMillis: 5_000,
      diagLogLevel: "none",
      metricReaders: [failingReader],
    });

    await tracingSDK.shutdown().catch(() => {});

    expect(failingReader.shutdownAttempts).toBe(1);
  });

  it("reports the original shutdown failure, not a later one", async () => {
    const tracingSDK = new TracingSDK({
      url: "http://localhost:1",
      forceFlushTimeoutMillis: 5_000,
      diagLogLevel: "none",
      metricReaders: [new FailingShutdownMetricReader()],
    });

    await expect(tracingSDK.shutdown()).rejects.toThrow("attempt 1");
  });
});
