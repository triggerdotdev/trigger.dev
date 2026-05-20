import { context, propagation, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";

export function createInMemoryTracing() {
  // Webapp's vitest config uses `pool: "forks"` with `--no-file-parallelism`,
  // so all test files in a shard share one process. globalThis persists
  // across files even though vitest clears the module cache between them.
  //
  // OTel's `provider.register()` calls trace/context/propagation
  // `setGlobal*` — and `setGlobal` no-ops (logs an error, returns false)
  // when a global is already set. Two patterns hit that path:
  // 1. `~/v3/tracer.server.ts` runs `provider.register()` via its
  //    `singleton("opentelemetry", setupTelemetry)` — first test in the
  //    shard to import that path sets the globals to webapp's tracer.
  // 2. A subsequent test calls `createInMemoryTracing()` to swap in its
  //    own in-memory provider. Without disabling first, register() is
  //    a no-op — the test's provider receives spans via its
  //    SimpleSpanProcessor (provider-scoped), but `trace.getActiveSpan()`
  //    (used by code under test, e.g. sentryTraceContext.server.ts)
  //    reads from the stale global context manager from step 1.
  //
  // Disable first, then register, so the test's provider always wins
  // for both span recording and the global API. After the test, the
  // next caller's createInMemoryTracing rotates again — no leakage.
  trace.disable();
  context.disable();
  propagation.disable();

  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();

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
