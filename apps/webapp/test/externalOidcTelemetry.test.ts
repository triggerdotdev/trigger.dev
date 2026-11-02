import { metrics } from "@opentelemetry/api";
import {
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { expect, it } from "vitest";
import { withOidcMetadataTelemetry } from "../app/services/oidc/externalOidcTelemetry.server";

// Catches: metadata instrumentation swallowing responses/errors or omitting failed requests.
it("preserves metadata responses and errors while counting their HTTP outcomes", async () => {
  const exporter = new InMemoryMetricExporter();
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);

  try {
    const response = new Response("keys", { headers: { "Cache-Control": "public, max-age=300" } });
    expect(await withOidcMetadataTelemetry("jwks", () => response)).toBe(response);

    const notFound = new Response(null, { status: 404 });
    await expect(
      withOidcMetadataTelemetry("discovery", () => {
        throw notFound;
      })
    ).rejects.toBe(notFound);

    const error = new Error("key store unavailable");
    await expect(
      withOidcMetadataTelemetry("jwks", () => {
        throw error;
      })
    ).rejects.toBe(error);

    await provider.forceFlush();
    const points = exporter
      .getMetrics()
      .flatMap((resource) =>
        resource.scopeMetrics.flatMap((scope) =>
          scope.metrics
            .filter((metric) => metric.descriptor.name === "external_oidc.metadata.duration")
            .flatMap((metric) => metric.dataPoints)
        )
      );
    expect(
      points.map((point) => ({
        attributes: point.attributes,
        count: typeof point.value === "object" ? point.value.count : undefined,
      }))
    ).toEqual(
      expect.arrayContaining([
        { attributes: { endpoint: "jwks", status_class: "2xx" }, count: 1 },
        { attributes: { endpoint: "discovery", status_class: "4xx" }, count: 1 },
        { attributes: { endpoint: "jwks", status_class: "5xx" }, count: 1 },
      ])
    );
  } finally {
    await provider.shutdown();
    metrics.disable();
  }
});
