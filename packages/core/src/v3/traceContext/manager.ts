import { Context, context, propagation, trace, TraceFlags } from "@opentelemetry/api";
import { TraceContextManager } from "./types.js";

export class StandardTraceContextManager implements TraceContextManager {
  public traceContext: Record<string, unknown> = {};

  getTraceContext() {
    return this.traceContext;
  }

  reset() {
    this.traceContext = {};
  }

  getExternalTraceContext() {
    return extractExternalTraceContext(this.traceContext?.external);
  }

  extractContext(): Context {
    return propagation.extract(context.active(), this.traceContext ?? {});
  }

  withExternalTrace<T>(fn: () => T): T {
    const externalTraceContext = this.getExternalTraceContext();

    if (!externalTraceContext) {
      return fn();
    }

    // Get the current active span context to extract the span ID
    const currentSpanContext = trace.getActiveSpan()?.spanContext();

    if (!currentSpanContext) {
      throw new Error(
        "No active span found. withExternalSpan must be called within an active span context."
      );
    }

    const spanContext = {
      traceId: externalTraceContext.traceId,
      spanId: currentSpanContext.spanId,
      traceFlags:
        typeof externalTraceContext.traceFlags === "string"
          ? externalTraceContext.traceFlags === "01"
            ? TraceFlags.SAMPLED
            : TraceFlags.NONE
          : TraceFlags.SAMPLED,
      isRemote: true,
    };

    const contextWithSpan = trace.setSpanContext(context.active(), spanContext);

    return context.with(contextWithSpan, fn);
  }
}

function extractExternalTraceContext(traceContext: unknown) {
  if (typeof traceContext !== "object" || traceContext === null) {
    return undefined;
  }

  const tracestate =
    "tracestate" in traceContext && typeof traceContext.tracestate === "string"
      ? traceContext.tracestate
      : undefined;

  if ("traceparent" in traceContext && typeof traceContext.traceparent === "string") {
    const [version, traceId, spanId, traceFlags] = traceContext.traceparent.split("-");

    if (!traceId || !spanId) {
      return undefined;
    }

    return {
      traceId,
      spanId,
      traceFlags,
      tracestate: tracestate,
    };
  }

  return undefined;
}
