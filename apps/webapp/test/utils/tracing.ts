import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";

export function createInMemoryTracing() {
  // Initialize the tracer provider and exporter
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();

  // Use the provider's tracer so spans hit this exporter even when a global
  // NodeTracerProvider was already registered (e.g. via tracer.server import chain).
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
