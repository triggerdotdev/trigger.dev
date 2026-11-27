import {
  context,
  diag,
  metrics,
  propagation,
  trace,
  type Counter,
  type MeterProvider,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { InstrumentationBase } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { MeterProvider as SdkMeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { createServer, type Server } from "node:http";
import type * as NodeHttp from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

async function listen(server: Server, host: string) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(0, host, resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("TracingSDK instrumentations", () => {
  let collector: Server | undefined;
  let tracingSDK: TracingSDK | undefined;
  let otherProvider: SdkMeterProvider | undefined;

  afterEach(async () => {
    try {
      await tracingSDK?.shutdown();
    } finally {
      context.disable();
      diag.disable();
      logs.disable();
      metrics.disable();
      propagation.disable();
      trace.disable();
      const cleanup = Promise.all([otherProvider?.shutdown(), collector && close(collector)]);
      tracingSDK = undefined;
      otherProvider = undefined;
      collector = undefined;
      await cleanup;
    }
  });

  it.each([
    ["bind to the SDK meter provider", false],
    ["bind to the SDK meter provider when another global provider is already set", true],
  ])("%s", async (_, hasGlobalProvider) => {
    const otherReader = hasGlobalProvider ? new CollectingMetricReader() : undefined;
    if (otherReader) {
      otherProvider = new SdkMeterProvider({ readers: [otherReader] });
      metrics.setGlobalMeterProvider(otherProvider);
    }

    // Shutdown exports the counter through the SDK's built-in OTLP reader.
    collector = createServer((request, response) => {
      request.resume();
      request.on("end", () => response.end("{}"));
    });
    const port = await listen(collector, "127.0.0.1");
    const url = `http://127.0.0.1:${port}`;
    const instrumentation = new CountingInstrumentation();
    const reader = new CollectingMetricReader();
    tracingSDK = new TracingSDK({
      url,
      metricsUrl: `${url}/v1/metrics`,
      forceFlushTimeoutMillis: 5_000,
      diagLogLevel: "none",
      instrumentations: [instrumentation],
      metricReaders: [reader],
    });

    instrumentation.counter!.add(1);
    expect(await collectedNames(reader)).toContain("test.instrumentation.calls");
    if (otherReader) {
      expect(await collectedNames(otherReader)).not.toContain("test.instrumentation.calls");
    }
  });
});

describe("ignoreOwnOtlpRequests with HttpInstrumentation", () => {
  // One instance for the file: a second instance doesn't re-patch an already loaded http module.
  const instrumentation = new HttpInstrumentation({ enabled: false });
  let http: typeof NodeHttp;
  beforeAll(() => {
    instrumentation.enable();
    http = createRequire(import.meta.url)("node:http") as typeof NodeHttp;
  });
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

    const reader = new CollectingMetricReader();
    const provider = new SdkMeterProvider({ readers: [reader] });
    try {
      const port = await listen(server, listenHost);
      const base = `http://${listenHost.includes(":") ? `[${listenHost}]` : listenHost}:${port}/otel`;

      ignoreOwnOtlpRequests(
        [instrumentation],
        [`${base}/v1/traces`, `${base}/v1/logs`, `${base}/v1/metrics?route=telemetry`]
      );
      instrumentation.setMeterProvider(provider);

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
      await Promise.all([close(server), provider.shutdown()]);
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
