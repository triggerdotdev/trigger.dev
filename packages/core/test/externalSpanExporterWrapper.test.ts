import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { beforeEach, describe, expect, it } from "vitest";
import { ExternalSpanExporterWrapper, FallbackExternalTraceId } from "../src/v3/otel/tracingSDK.js";
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
    // `setGlobalManager` delegates to `registerGlobal`, which ignores a second
    // registration — without disabling first, every test after the first would
    // keep mutating the first test's manager.
    traceContext.disable();
    manager = new StandardTraceContextManager();
    traceContext.setGlobalManager(manager);
  });

  it("rewrites attempt spans using the manager's current external context, not the value captured at construction", () => {
    const { exporter, captured } = makeCapturingExporter();

    manager.traceContext = { external: { traceparent: TRACEPARENT_RUN_A } };

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceId("ffffffffffffffffffffffffffffffff")
    );

    manager.traceContext = { external: { traceparent: TRACEPARENT_RUN_B } };

    wrapper.export([createAttemptSpan()], () => {});

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(1);

    const span = captured[0]![0]!;
    expect(span.parentSpanContext?.spanId).toBe("2222222222222222");
    expect(span.parentSpanContext?.spanId).not.toBe("1111111111111111");
    expect(span.parentSpanContext?.traceId).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(span.spanContext().traceId).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  // Runs triggered internally — a schedule, or one task triggering another —
  // carry no external trace context and so take the generated fallback. That id
  // was captured at construction, which on a warm-started worker meant every run
  // on the process shared a single trace id.
  it("mints a new fallback trace id per run when there is no external context", () => {
    const { exporter, captured } = makeCapturingExporter();

    let generated = 0;
    const idGenerator = {
      generateTraceId: () => `${++generated}`.padStart(32, "0"),
    };

    manager.traceContext = { traceparent: TRACEPARENT_RUN_A };

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceId("ffffffffffffffffffffffffffffffff", idGenerator)
    );

    wrapper.export([createAttemptSpan()], () => {});

    // A second run on the same warm process: the manager is reassigned, so the
    // fallback has to be reminted.
    manager.traceContext = { traceparent: TRACEPARENT_RUN_B };

    wrapper.export([createAttemptSpan()], () => {});

    const runATraceId = captured[0]![0]!.spanContext().traceId;
    const runBTraceId = captured[1]![0]!.spanContext().traceId;

    expect(runATraceId).toBe("ffffffffffffffffffffffffffffffff");
    expect(runBTraceId).not.toBe(runATraceId);
    expect(runBTraceId).toBe("00000000000000000000000000000001");
  });

  it("keeps one fallback trace id across every export within a run", () => {
    const { exporter, captured } = makeCapturingExporter();

    let generated = 0;
    const idGenerator = {
      generateTraceId: () => `${++generated}`.padStart(32, "0"),
    };

    manager.traceContext = { traceparent: TRACEPARENT_RUN_A };

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceId("ffffffffffffffffffffffffffffffff", idGenerator)
    );

    wrapper.export([createAttemptSpan()], () => {});
    wrapper.export([createAttemptSpan()], () => {});

    expect(captured[1]![0]!.spanContext().traceId).toBe(captured[0]![0]!.spanContext().traceId);
    expect(generated).toBe(0);
  });

  it("leaves external export off when no external trace id was configured", () => {
    const { exporter, captured } = makeCapturingExporter();

    const idGenerator = {
      generateTraceId: () => "00000000000000000000000000000001",
    };

    manager.traceContext = { traceparent: TRACEPARENT_RUN_A };

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceId("", idGenerator)
    );

    wrapper.export([createAttemptSpan()], () => {});

    // Minting an id here would switch external export on for a deployment that
    // never asked for it.
    expect(captured[0]).toHaveLength(0);
  });

  // The TracingSDK shares one FallbackExternalTraceId across every span and log
  // wrapper. Giving each wrapper its own would remint them independently, so
  // from the second run on, a run's logs would carry a different trace id than
  // its spans and stop correlating in the external backend.
  it("gives every wrapper sharing one fallback the same id after a remint", () => {
    const first = makeCapturingExporter();
    const second = makeCapturingExporter();

    let generated = 0;
    const idGenerator = {
      generateTraceId: () => `${++generated}`.padStart(32, "0"),
    };

    manager.traceContext = { traceparent: TRACEPARENT_RUN_A };

    const fallback = new FallbackExternalTraceId("ffffffffffffffffffffffffffffffff", idGenerator);
    const spanWrapper = new ExternalSpanExporterWrapper(first.exporter, fallback);
    const otherWrapper = new ExternalSpanExporterWrapper(second.exporter, fallback);

    manager.traceContext = { traceparent: TRACEPARENT_RUN_B };

    spanWrapper.export([createAttemptSpan()], () => {});
    otherWrapper.export([createAttemptSpan()], () => {});

    expect(second.captured[0]![0]!.spanContext().traceId).toBe(
      first.captured[0]![0]!.spanContext().traceId
    );
    expect(generated).toBe(1);
  });

  // The noop manager returns a fresh `{}` on every call, so using its identity
  // as the run boundary would remint on every export and shatter one run's
  // trace into many.
  it("holds the id when no trace context manager is registered", () => {
    const { exporter, captured } = makeCapturingExporter();

    let generated = 0;
    const idGenerator = {
      generateTraceId: () => `${++generated}`.padStart(32, "0"),
    };

    traceContext.disable();

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceId("ffffffffffffffffffffffffffffffff", idGenerator)
    );

    wrapper.export([createAttemptSpan()], () => {});
    wrapper.export([createAttemptSpan()], () => {});

    expect(captured[1]![0]!.spanContext().traceId).toBe(captured[0]![0]!.spanContext().traceId);
    expect(generated).toBe(0);
  });
});
