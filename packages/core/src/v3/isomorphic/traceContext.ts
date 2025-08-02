export function parseTraceparent(
  traceparent?: string
): { traceId: string; spanId: string } | undefined {
  if (!traceparent) {
    return undefined;
  }

  const parts = traceparent.split("-");

  if (parts.length !== 4) {
    return undefined;
  }

  const [version, traceId, spanId] = parts;

  if (version !== "00") {
    return undefined;
  }

  if (!traceId || !spanId) {
    return undefined;
  }

  return { traceId, spanId };
}

export function serializeTraceparent(traceId: string, spanId: string) {
  return `00-${traceId}-${spanId}-01`;
}
