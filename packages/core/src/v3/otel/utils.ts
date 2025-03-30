import { type Span, SpanStatusCode, context, propagation } from "@opentelemetry/api";

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

export function carrierFromContext(): Record<string, string> {
  const carrier = {};
  propagation.inject(context.active(), carrier);

  return carrier;
}
