import { ROOT_CONTEXT, TraceFlags, context, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import {
  addOtelTraceContextToEvent,
  getActiveTraceIds,
} from "../app/utils/sentryTraceContext.server";
import { createInMemoryTracing } from "./utils/tracing";

describe("getActiveTraceIds", () => {
  it("returns undefined when no OTel span is active", () => {
    expect(getActiveTraceIds()).toBeUndefined();
  });

  it("returns the trace_id, span_id, and sampled=true for an active recording span", () => {
    const { tracer } = createInMemoryTracing();

    tracer.startActiveSpan("test-span", (span) => {
      const ids = getActiveTraceIds();
      expect(ids).toEqual({
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        sampled: true,
      });
      span.end();
    });
  });

  it("returns sampled=false when the active span is non-recording", () => {
    // Initialise the global context manager (createInMemoryTracing does this
    // as a side effect of NodeTracerProvider.register()).
    createInMemoryTracing();

    const nonSampledSpan = trace.wrapSpanContext({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: TraceFlags.NONE,
    });

    context.with(trace.setSpan(ROOT_CONTEXT, nonSampledSpan), () => {
      expect(getActiveTraceIds()).toEqual({
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        sampled: false,
      });
    });
  });
});

describe("addOtelTraceContextToEvent", () => {
  it("returns the event unchanged when no OTel span is active", () => {
    const event = { message: "boom" };
    const result = addOtelTraceContextToEvent(event, {});
    expect(result).toBe(event);
    expect(result).toEqual({ message: "boom" });
  });

  it("stamps trace_id and span_id from the active span onto event.contexts.trace", () => {
    const { tracer } = createInMemoryTracing();

    tracer.startActiveSpan("test-span", (span) => {
      const event = { message: "boom" };
      const result = addOtelTraceContextToEvent(event, {});
      expect(result.contexts?.trace?.trace_id).toBe(span.spanContext().traceId);
      expect(result.contexts?.trace?.span_id).toBe(span.spanContext().spanId);
      span.end();
    });
  });

  it("tags the event with otel_sampled=true when the active span is recording", () => {
    const { tracer } = createInMemoryTracing();

    tracer.startActiveSpan("test-span", (span) => {
      const event = { message: "boom" };
      const result = addOtelTraceContextToEvent(event, {});
      expect(result.tags?.otel_sampled).toBe("true");
      span.end();
    });
  });

  it("tags the event with otel_sampled=false when the active span is non-recording", () => {
    createInMemoryTracing();

    const nonSampledSpan = trace.wrapSpanContext({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: TraceFlags.NONE,
    });

    context.with(trace.setSpan(ROOT_CONTEXT, nonSampledSpan), () => {
      const event = { message: "boom" };
      const result = addOtelTraceContextToEvent(event, {});
      expect(result.tags?.otel_sampled).toBe("false");
    });
  });

  it("preserves existing event.contexts.trace fields", () => {
    const { tracer } = createInMemoryTracing();

    tracer.startActiveSpan("test-span", (span) => {
      const event = {
        message: "boom",
        contexts: {
          trace: { op: "http.server", description: "GET /things" },
          runtime: { name: "node" },
        },
      };
      const result = addOtelTraceContextToEvent(event, {});
      expect(result.contexts?.trace).toMatchObject({
        op: "http.server",
        description: "GET /things",
        trace_id: span.spanContext().traceId,
        span_id: span.spanContext().spanId,
      });
      expect(result.contexts?.runtime).toEqual({ name: "node" });
      span.end();
    });
  });

  it("returns the event unchanged if reading the OTel context throws", () => {
    const throwingAccessor = () => {
      throw new Error("otel api blew up");
    };
    const event = { message: "boom" };
    const result = addOtelTraceContextToEvent(event, {}, throwingAccessor);
    expect(result).toBe(event);
  });
});
