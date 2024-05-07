import { Span, SpanStatusCode } from "@opentelemetry/api";

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
