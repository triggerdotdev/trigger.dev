import { SpanOptions, SpanStatusCode, Span, Tracer } from "@opentelemetry/api";

export async function startSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions
): Promise<T> {
  return tracer.startActiveSpan(name, options ?? {}, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      } else if (typeof error === "string") {
        span.recordException(new Error(error));
      } else {
        span.recordException(new Error(String(error)));
      }

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });

      throw error;
    } finally {
      span.end();
    }
  });
}
