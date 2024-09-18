import { Span, SpanStatusCode } from "@opentelemetry/api";

export { TracingSDK, type TracingSDKConfig, type TracingDiagnosticLogLevel } from "./tracingSDK.js";

export function recordSpanException(span: Span, error: unknown) {
  if (error instanceof Error) {
    span.recordException(sanitizeSpanError(error));
  } else if (typeof error === "string") {
    span.recordException(error.replace(/\0/g, ""));
  } else {
    span.recordException(JSON.stringify(error).replace(/\0/g, ""));
  }

  span.setStatus({ code: SpanStatusCode.ERROR });
}

function sanitizeSpanError(error: Error) {
  // Create a new error object with the same name, message and stack trace
  const sanitizedError = new Error(error.message.replace(/\0/g, ""));
  sanitizedError.name = error.name.replace(/\0/g, "");
  sanitizedError.stack = error.stack?.replace(/\0/g, "");

  return sanitizedError;
}
