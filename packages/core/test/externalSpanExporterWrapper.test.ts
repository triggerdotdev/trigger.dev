import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { beforeEach, describe, expect, it } from "vitest";
import { ExternalSpanExporterWrapper } from "../src/v3/otel/tracingSDK.js";
import { SemanticInternalAttributes } from "../src/v3/semanticInternalAttributes.js";
import { traceContext } from "../src/v3/trace-context-api.js";
import { StandardTraceContextManager } from "../src/v3/traceContext/manager.js";

const TRACEPARENT_RUN_A = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01";
const TRACEPARENT_RUN_B = "00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-2222222222222222-01";

function createAttemptSpan(): ReadableSpan {
  const spanCtx = {
    traceId: "cccccccccccccccccccccccccccccccc",
    spanId: "3333333333333333",
    traceFlags: TraceFlags.SAMPLED,
  };
  return {
    name: "Attempt 1",
    kind: SpanKind.CONSUMER,
    spanContext: () => spanCtx,
    parentSpanContext: undefined,
    startTime: [0, 0],
    endTime: [0, 0],
    status: { code: SpanStatusCode.UNSET },
    attributes: { [SemanticInternalAttributes.SPAN_ATTEMPT]: true },
    links: [],
    events: [],
    duration: [0, 0],
    ended: true,
    resource: {} as any,
    instrumentationLibrary: { name: "test" } as any,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

function makeCapturingExporter(): { exporter: SpanExporter; captured: ReadableSpan[][] } {
  const captured: ReadableSpan[][] = [];
  const exporter: SpanExporter = {
    export: (spans, cb) => {
      captured.push(spans);
      cb({ code: 0 } as any);
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
  return { exporter, captured };
}

describe("ExternalSpanExporterWrapper warm-start regression", () => {
  let manager: StandardTraceContextManager;

  beforeEach(() => {
    manager = new StandardTraceContextManager();
    traceContext.setGlobalManager(manager);
  });

  it("rewrites attempt spans using the manager's current external context, not the value captured at construction", () => {
    const { exporter, captured } = makeCapturingExporter();

    manager.traceContext = { external: { traceparent: TRACEPARENT_RUN_A } };

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      "ffffffffffffffffffffffffffffffff"
    );

    manager.traceContext = { external: { traceparent: TRACEPARENT_RUN_B } };

    wrapper.export([createAttemptSpan()], () => {});

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(1);

    const span = captured[0]![0]!;
    expect(span.parentSpanContext?.spanId).toBe("2222222222222222");
    expect(span.parentSpanContext?.spanId).not.toBe("1111111111111111");
    expect(span.spanContext().traceId).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });
});
