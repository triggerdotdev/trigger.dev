import { type Span, SpanStatusCode, context, propagation } from "@opentelemetry/api";
import { truncateStack, truncateMessage } from "../errors.js";

const MAX_GENERIC_LENGTH = 5_000;

function truncateGeneric(value: string): string {
  return value.length > MAX_GENERIC_LENGTH
    ? value.slice(0, MAX_GENERIC_LENGTH) + "...[truncated]"
    : value;
}

function serializeFallback(error: unknown): string {
  // JSON.stringify can throw (circular refs, BigInt) or return undefined
  // (symbol, undefined, function). Fall back to String() in both cases so we
  // never mask the original error being recorded.
  try {
    const json = JSON.stringify(error);
    if (json != null) return json;
  } catch {
    // fall through
  }
  try {
    return String(error);
  } catch {
    return "[unserializable error]";
  }
}

export function recordSpanException(span: Span, error: unknown) {
  if (error instanceof Error) {
    span.recordException(sanitizeSpanError(error));
  } else if (typeof error === "string") {
    span.recordException(truncateGeneric(error.replace(/\0/g, "")));
  } else {
    span.recordException(truncateGeneric(serializeFallback(error).replace(/\0/g, "")));
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
