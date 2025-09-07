import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";

export function createInMemoryTracing() {
  // Initialize the tracer provider and exporter
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();

  // Retrieve the tracer
  const tracer = trace.getTracer("test-tracer");

  return {
    exporter,
    tracer,
  };
}
