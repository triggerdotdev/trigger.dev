/** Documents apps/supervisor/src/services/otlpTraceService.test.ts module purpose and public usage context */
import { describe, it, expect } from "vitest";
import { buildPayload } from "./otlpTraceService.js";

describe("buildPayload", () => {
  it("builds valid OTLP JSON with timing attributes", () => {
    const payload = buildPayload({
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
    const payload = buildPayload({
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
    const payload = buildPayload({
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

  it("converts real epoch timestamps without precision loss", () => {
    // Date.now() values exceed Number.MAX_SAFE_INTEGER when multiplied by 1e6
    const startMs = 1711929600000; // 2024-04-01T00:00:00Z
    const endMs = 1711929600250;

    const payload = buildPayload({
      traceId: "abcd1234abcd1234abcd1234abcd1234",
      spanName: "test",
      startTimeMs: startMs,
      endTimeMs: endMs,
      resourceAttributes: {},
      spanAttributes: {},
    });

    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.startTimeUnixNano).toBe("1711929600000000000");
    expect(span.endTimeUnixNano).toBe("1711929600250000000");
  });

  it("preserves sub-millisecond precision from performance.now() arithmetic", () => {
    // provisionStartEpochMs = Date.now() - (performance.now() - startMs) produces fractional ms.
    // Use small epoch + fraction to avoid IEEE 754 noise in the fractional part.
    const startMs = 1000.322;
    const endMs = 1045.789;

    const payload = buildPayload({
      traceId: "abcd1234abcd1234abcd1234abcd1234",
      spanName: "test",
      startTimeMs: startMs,
      endTimeMs: endMs,
      resourceAttributes: {},
      spanAttributes: {},
    });

    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.startTimeUnixNano).toBe("1000322000");
    expect(span.endTimeUnixNano).toBe("1045789000");
  });

  it("sub-ms precision affects ordering for real epoch values", () => {
    // Two spans within the same millisecond should have different nanosecond timestamps
    const spanA = buildPayload({
      traceId: "abcd1234abcd1234abcd1234abcd1234",
      spanName: "a",
      startTimeMs: 1711929600000.3,
      endTimeMs: 1711929600001,
      resourceAttributes: {},
      spanAttributes: {},
    });

    const spanB = buildPayload({
      traceId: "abcd1234abcd1234abcd1234abcd1234",
      spanName: "b",
      startTimeMs: 1711929600000.7,
      endTimeMs: 1711929600001,
      resourceAttributes: {},
      spanAttributes: {},
    });

    const startA = BigInt(spanA.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.startTimeUnixNano);
    const startB = BigInt(spanB.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.startTimeUnixNano);
    // A should sort before B (both in the same ms but different sub-ms positions)
    expect(startA).toBeLessThan(startB);
  });

  it("omits parentSpanId when not provided", () => {
    const payload = buildPayload({
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
    const payload = buildPayload({
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
