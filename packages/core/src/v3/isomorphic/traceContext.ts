export function parseTraceparent(
  traceparent?: string
): { traceId: string; spanId: string; traceFlags?: string } | undefined {
  if (!traceparent) {
    return undefined;
  }

  const parts = traceparent.split("-");

  if (parts.length !== 4) {
    return undefined;
  }

  const [version, traceId, spanId, traceFlags] = parts;

  if (version !== "00") {
    return undefined;
  }

  if (!traceId || !spanId) {
    return undefined;
  }

  return { traceId, spanId, traceFlags };
}

export function serializeTraceparent(traceId: string, spanId: string, traceFlags?: string) {
  return `00-${traceId}-${spanId}-${traceFlags ?? "01"}`;
}
