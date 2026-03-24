import { describe, it, expect } from "vitest";
import { buildOtlpTracePayload } from "./otlpTrace.js";

describe("buildOtlpTracePayload", () => {
  it("builds valid OTLP JSON with timing attributes", () => {
    const payload = buildOtlpTracePayload({
      traceId: "abcd1234abcd1234abcd1234abcd1234",
      parentSpanId: "1234567890abcdef",
      spanName: "compute.provision",
      startTimeMs: 1000,
      endTimeMs: 1250,
      resourceAttributes: {
        "ctx.environment.id": "env_123",
        "ctx.organization.id": "org_456",
        "ctx.project.id": "proj_789",
        "ctx.run.id": "run_abc",
      },
      spanAttributes: {
        "compute.total_ms": 250,
        "compute.gateway.schedule_ms": 1,
        "compute.cache.image_cached": true,
      },
    });

    expect(payload.resourceSpans).toHaveLength(1);

    const resourceSpan = payload.resourceSpans[0]!;

    // $trigger=true so the webapp accepts it
    const triggerAttr = resourceSpan.resource.attributes.find((a) => a.key === "$trigger");
    expect(triggerAttr).toEqual({ key: "$trigger", value: { boolValue: true } });

    // Resource attributes
    const envAttr = resourceSpan.resource.attributes.find(
      (a) => a.key === "ctx.environment.id"
    );
    expect(envAttr).toEqual({
      key: "ctx.environment.id",
      value: { stringValue: "env_123" },
    });

    // Span basics
    const span = resourceSpan.scopeSpans[0]!.spans[0]!;
    expect(span.name).toBe("compute.provision");
    expect(span.traceId).toBe("abcd1234abcd1234abcd1234abcd1234");
    expect(span.parentSpanId).toBe("1234567890abcdef");

    // Integer attribute
    const totalMs = span.attributes.find((a) => a.key === "compute.total_ms");
    expect(totalMs).toEqual({ key: "compute.total_ms", value: { intValue: 250 } });

    // Boolean attribute
    const cached = span.attributes.find((a) => a.key === "compute.cache.image_cached");
    expect(cached).toEqual({ key: "compute.cache.image_cached", value: { boolValue: true } });
  });

  it("generates a valid 16-char hex span ID", () => {
    const payload = buildOtlpTracePayload({
      traceId: "abcd1234abcd1234abcd1234abcd1234",
      spanName: "test",
      startTimeMs: 1000,
      endTimeMs: 1001,
      resourceAttributes: {},
      spanAttributes: {},
    });

    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("converts timestamps to nanoseconds", () => {
    const payload = buildOtlpTracePayload({
      traceId: "abcd1234abcd1234abcd1234abcd1234",
      spanName: "test",
      startTimeMs: 1000,
      endTimeMs: 1250,
      resourceAttributes: {},
      spanAttributes: {},
    });

    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.startTimeUnixNano).toBe("1000000000");
    expect(span.endTimeUnixNano).toBe("1250000000");
  });

  it("omits parentSpanId when not provided", () => {
    const payload = buildOtlpTracePayload({
      traceId: "abcd1234abcd1234abcd1234abcd1234",
      spanName: "test",
      startTimeMs: 1000,
      endTimeMs: 1001,
      resourceAttributes: {},
      spanAttributes: {},
    });

    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.parentSpanId).toBeUndefined();
  });

  it("handles double values for non-integer numbers", () => {
    const payload = buildOtlpTracePayload({
      traceId: "abcd1234abcd1234abcd1234abcd1234",
      spanName: "test",
      startTimeMs: 1000,
      endTimeMs: 1001,
      resourceAttributes: {},
      spanAttributes: { "compute.cpu": 0.25 },
    });

    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    const cpu = span.attributes.find((a) => a.key === "compute.cpu");
    expect(cpu).toEqual({ key: "compute.cpu", value: { doubleValue: 0.25 } });
  });
});
