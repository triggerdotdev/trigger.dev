import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";

export function createInMemoryTracing() {
  // Initialize the tracer provider and exporter — but do NOT call
  // `provider.register()`. Calling register() sets the OTel global APIs
  // (trace/context/propagation), and webapp's `~/v3/tracer.server.ts`
  // also calls register() via its singleton. Webapp's `vitest.config.ts`
  // uses `pool: "forks"` with `--no-file-parallelism`, so all test
  // files in a shard share one process — globals set by the first test
  // to load tracer.server.ts conflict with subsequent createInMemoryTracing
  // calls, throwing "Attempted duplicate registration of API: trace".
  //
  // The tracer returned from `provider.getTracer(...)` is scoped to
  // this provider, so the InMemorySpanExporter still receives the
  // spans the consuming test creates — no global registration needed.
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  const tracer = provider.getTracer("test-tracer");

  return {
    exporter,
    tracer,
  };
}

export function createInMemoryMetrics() {
  // Initialize the metric exporter with cumulative temporality for easier testing
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);

  // Create a metric reader that exports frequently for testing
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 100, // Export frequently for tests
  });

  // Initialize the meter provider
  const meterProvider = new MeterProvider({
    readers: [metricReader],
  });

  // Retrieve a meter
  const meter = meterProvider.getMeter("test-meter");

  return {
    metricExporter,
    metricReader,
    meterProvider,
    meter,
    // Helper to force collection and get metrics
    async getMetrics() {
      await metricReader.forceFlush();
      return metricExporter.getMetrics();
    },
    // Helper to reset metrics between tests
    reset() {
      metricExporter.reset();
    },
    // Helper to shutdown the meter provider
    async shutdown() {
      await meterProvider.shutdown();
    },
  };
}
