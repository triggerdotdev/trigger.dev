import { metrics, type Counter, type MeterProvider } from "@opentelemetry/api";
import { InstrumentationBase } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { MeterProvider as SdkMeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import type * as NodeHttp from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ignoreOwnOtlpRequests, TracingSDK } from "./tracingSDK.js";

class CollectingMetricReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

class CountingInstrumentation extends InstrumentationBase {
  counter?: Counter;

  constructor() {
    super("test-instrumentation", "1.0.0", { enabled: false });
  }

  protected init() {
    return [];
  }

  override setMeterProvider(meterProvider: MeterProvider) {
    super.setMeterProvider(meterProvider);
    this.counter = this.meter.createCounter("test.instrumentation.calls");
  }
}

async function collectedNames(reader: CollectingMetricReader) {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics
    .flatMap((scopeMetrics) => scopeMetrics.metrics)
    .map((metric) => metric.descriptor.name);
}

describe("TracingSDK instrumentations", () => {
  // Each SDK must start with the no-op global meter provider, as in a fresh worker process.
  afterEach(() => metrics.disable());

  it("bind to the SDK meter provider", async () => {
    const instrumentation = new CountingInstrumentation();
    const reader = new CollectingMetricReader();

    const tracingSDK = new TracingSDK({
      url: "http://localhost:1",
      forceFlushTimeoutMillis: 5_000,
      diagLogLevel: "none",
      instrumentations: [instrumentation],
      metricReaders: [reader],
    });

    instrumentation.counter!.add(1);
    expect(await collectedNames(reader)).toContain("test.instrumentation.calls");

    await tracingSDK.shutdown().catch(() => {});
  });

  it("bind to the SDK meter provider when another global provider is already set", async () => {
    const otherReader = new CollectingMetricReader();
    metrics.setGlobalMeterProvider(new SdkMeterProvider({ readers: [otherReader] }));

    const instrumentation = new CountingInstrumentation();
    const reader = new CollectingMetricReader();

    const tracingSDK = new TracingSDK({
      url: "http://localhost:1",
      forceFlushTimeoutMillis: 5_000,
      diagLogLevel: "none",
      instrumentations: [instrumentation],
      metricReaders: [reader],
    });

    instrumentation.counter!.add(1);
    expect(await collectedNames(reader)).toContain("test.instrumentation.calls");
    expect(await collectedNames(otherReader)).not.toContain("test.instrumentation.calls");

    await tracingSDK.shutdown().catch(() => {});
  });
});

describe("ignoreOwnOtlpRequests with HttpInstrumentation", () => {
  // One instance for the file: a second instance doesn't re-patch an already loaded http module.
  const instrumentation = new HttpInstrumentation();
  const http = createRequire(import.meta.url)("node:http") as typeof NodeHttp;
  afterAll(() => instrumentation.disable());

  // Sends export POSTs plus requests that differ from an export only by method, path or query,
  // all to one listener through the real patched http module, and counts measured requests by method and status.
  async function measuredRequests(listenHost: string) {
    instrumentation.setConfig({});
    // A distinct status per application request, so a mix-up can't hide behind a per-method total.
    const server = http.createServer((request, response) => {
      response.statusCode =
        request.method === "GET"
          ? 203
          : request.url?.endsWith("/api")
            ? 201
            : request.url?.includes("route=application")
              ? 202
              : 200;
      request.resume();
      request.on("end", () => response.end("{}"));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject).listen(0, listenHost, resolve);
      });
      const { port } = server.address() as AddressInfo;
      const base = `http://${listenHost.includes(":") ? `[${listenHost}]` : listenHost}:${port}/otel`;

      const reader = new CollectingMetricReader();
      ignoreOwnOtlpRequests(
        [instrumentation],
        [`${base}/v1/traces`, `${base}/v1/logs`, `${base}/v1/metrics?route=telemetry`]
      );
      instrumentation.setMeterProvider(new SdkMeterProvider({ readers: [reader] }));

      const send = (method: string, path: string) =>
        new Promise<void>((resolve, reject) => {
          http
            .request(`${base}${path}`, { method }, (response) => {
              response.resume();
              response.on("end", resolve);
            })
            .on("error", reject)
            .end(method === "POST" ? "{}" : undefined);
        });
      // Exports (status 200): skipped.
      await send("POST", "/v1/traces");
      await send("POST", "/v1/metrics?route=telemetry");
      // Application requests: measured.
      await send("POST", "/api");
      await send("POST", "/v1/metrics?route=application");
      await send("GET", "/v1/metrics?route=telemetry");

      const { resourceMetrics } = await reader.collect();
      const counts: Record<string, number> = {};
      for (const metric of resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics)) {
        if (metric.descriptor.name !== "http.client.duration") continue;
        for (const point of metric.dataPoints) {
          const key = `${point.attributes["http.method"]} ${point.attributes["http.status_code"]}`;
          counts[key] = (counts[key] ?? 0) + (point.value as { count: number }).count;
        }
      }
      return counts;
    } finally {
      server.close();
    }
  }

  it("skips export POSTs but measures other requests to the same collector", async () => {
    expect(await measuredRequests("127.0.0.1")).toEqual({
      "POST 201": 1,
      "POST 202": 1,
      "GET 203": 1,
    });
  });

  it("matches IPv6 export URLs", async (context) => {
    const counts = await measuredRequests("::1").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT") return undefined;
      throw error;
    });
    if (!counts) return context.skip("IPv6 loopback is not available");
    expect(counts).toEqual({ "POST 201": 1, "POST 202": 1, "GET 203": 1 });
  });
});
