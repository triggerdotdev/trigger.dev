import { Span, SpanStatusCode } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";
import type { Logger } from "@opentelemetry/api-logs";

export type { Tracer as OtelTracer, Logger as OtelLogger };
export { TracingSDK, type TracingSDKConfig, type TracingDiagnosticLogLevel } from "./tracingSDK";

export function recordSpanException(span: Span, error: unknown) {
  if (error instanceof Error) {
    span.recordException(error);
  } else if (typeof error === "string") {
    span.recordException(new Error(error));
  } else {
    span.recordException(new Error(JSON.stringify(error)));
  }

  span.setStatus({ code: SpanStatusCode.ERROR });
}
