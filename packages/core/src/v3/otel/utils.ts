import { type Span, SpanStatusCode, context, propagation } from "@opentelemetry/api";
import { truncateStack, truncateMessage } from "../errors.js";

const MAX_GENERIC_LENGTH = 5_000;

export function recordSpanException(span: Span, error: unknown) {
  if (error instanceof Error) {
    span.recordException(sanitizeSpanError(error));
  } else if (typeof error === "string") {
    const clean = error.replace(/\0/g, "");
    span.recordException(
      clean.length > MAX_GENERIC_LENGTH ? clean.slice(0, MAX_GENERIC_LENGTH) + "...[truncated]" : clean
    );
  } else {
    const json = JSON.stringify(error).replace(/\0/g, "");
    span.recordException(
      json.length > MAX_GENERIC_LENGTH ? json.slice(0, MAX_GENERIC_LENGTH) + "...[truncated]" : json
    );
  }

  span.setStatus({ code: SpanStatusCode.ERROR });
}

function sanitizeSpanError(error: Error) {
  const sanitizedError = new Error(truncateMessage(error.message.replace(/\0/g, "")));
  sanitizedError.name = error.name.replace(/\0/g, "");
  sanitizedError.stack = truncateStack(error.stack?.replace(/\0/g, "")) || undefined;

  return sanitizedError;
}

export function carrierFromContext(): Record<string, string> {
  const carrier = {};
  propagation.inject(context.active(), carrier);

  return carrier;
}
