import { type Span, TraceFlags, trace } from "@opentelemetry/api";
import type { Event, EventHint } from "@sentry/remix";

export type GetActiveSpan = () => Span | undefined;

const defaultGetActiveSpan: GetActiveSpan = () => trace.getActiveSpan();

export function getActiveTraceIds(
  getActiveSpan: GetActiveSpan = defaultGetActiveSpan
): { traceId: string; spanId: string; sampled: boolean } | undefined {
  try {
    const span = getActiveSpan();
    if (!span) return undefined;
    const ctx = span.spanContext();
    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      sampled: (ctx.traceFlags & TraceFlags.SAMPLED) !== 0,
    };
  } catch {
    return undefined;
  }
}

export function addOtelTraceContextToEvent(
  event: Event,
  _hint: EventHint,
  getActiveSpan: GetActiveSpan = defaultGetActiveSpan
): Event {
  const ids = getActiveTraceIds(getActiveSpan);
  if (!ids) return event;
  // We intentionally overwrite Sentry's own trace_id/span_id on contexts.trace.
  // With skipOpenTelemetrySetup: true, Sentry generates an internal trace_id
  // unrelated to OTel; replacing it with the active OTel ids is the whole
  // point of this processor — it makes Sentry issues navigable to the
  // corresponding OTel trace in any backend.
  return {
    ...event,
    contexts: {
      ...event.contexts,
      trace: {
        ...event.contexts?.trace,
        trace_id: ids.traceId,
        span_id: ids.spanId,
      },
    },
    tags: {
      ...event.tags,
      otel_sampled: ids.sampled ? "true" : "false",
    },
  };
}
