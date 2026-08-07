import type { Context } from "@opentelemetry/api";
import { context, propagation, trace } from "@opentelemetry/api";
import { parseTraceParent } from "@opentelemetry/core";
import type { TraceContextManager } from "./types.js";

export class StandardTraceContextManager implements TraceContextManager {
  #traceContext: Record<string, unknown> = {};
  #epoch = 0;

  // An accessor rather than a plain field so that replacing the context, which
  // is what starting a run does, is what advances the epoch. Call sites are
  // unchanged.
  get traceContext(): Record<string, unknown> {
    return this.#traceContext;
  }

  set traceContext(value: Record<string, unknown>) {
    this.#traceContext = value;
    this.#epoch++;
  }

  getTraceContext() {
    return this.traceContext;
  }

  getTraceContextEpoch() {
    return this.#epoch;
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
      traceFlags: externalTraceContext.traceFlags,
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
    const externalSpanContext = parseTraceParent(traceContext.traceparent);

    if (!externalSpanContext) {
      return undefined;
    }

    return {
      traceId: externalSpanContext.traceId,
      spanId: externalSpanContext.spanId,
      traceFlags: externalSpanContext.traceFlags,
      tracestate: tracestate,
    };
  }

  return undefined;
}
