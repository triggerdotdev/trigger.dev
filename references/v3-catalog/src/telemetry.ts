import { trace } from "@opentelemetry/api";

export const tracer = trace.getTracer("v3-catalog", "3.0.0.dp.1");

export function traceAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn();
    } finally {
      span.end();
    }
  });
}
