import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ExternalLogRecordExporterWrapper,
  ExternalSpanExporterWrapper,
  FallbackExternalTraceId,
} from "../src/v3/otel/tracingSDK.js";
import { SemanticInternalAttributes } from "../src/v3/semanticInternalAttributes.js";
import { traceContext } from "../src/v3/trace-context-api.js";
import { StandardTraceContextManager } from "../src/v3/traceContext/manager.js";

const TRACEPARENT_RUN_A = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01";
const TRACEPARENT_RUN_B = "00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-2222222222222222-01";
const SEED = "ffffffffffffffffffffffffffffffff";

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

function createLogRecord(): ReadableLogRecord {
  return {
    body: "hello",
    attributes: {},
    spanContext: {
      traceId: "cccccccccccccccccccccccccccccccc",
      spanId: "3333333333333333",
      traceFlags: TraceFlags.SAMPLED,
    },
  } as unknown as ReadableLogRecord;
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

function makeCapturingLogExporter(): {
  exporter: LogRecordExporter;
  captured: ReadableLogRecord[][];
} {
  const captured: ReadableLogRecord[][] = [];
  const exporter: LogRecordExporter = {
    export: (records, cb) => {
      captured.push(records);
      cb({ code: 0 } as any);
    },
    shutdown: () => Promise.resolve(),
  };
  return { exporter, captured };
}

/** Yields 000…001, 000…002, … so a reminted id is identifiable by its ordinal. */
function makeIdGenerator() {
  let generated = 0;
  return {
    generateTraceId: () => `${++generated}`.padStart(32, "0"),
    get count() {
      return generated;
    },
  };
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

    const wrapper = new ExternalSpanExporterWrapper(exporter, new FallbackExternalTraceId(SEED));

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
    const idGenerator = makeIdGenerator();

    manager.traceContext = { traceparent: TRACEPARENT_RUN_A };

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceId(SEED, idGenerator)
    );

    wrapper.export([createAttemptSpan()], () => {});

    // A second run on the same warm process.
    manager.traceContext = { traceparent: TRACEPARENT_RUN_B };

    wrapper.export([createAttemptSpan()], () => {});

    const runATraceId = captured[0]![0]!.spanContext().traceId;
    const runBTraceId = captured[1]![0]!.spanContext().traceId;

    expect(runATraceId).toBe(SEED);
    expect(runBTraceId).not.toBe(runATraceId);
    expect(runBTraceId).toBe("00000000000000000000000000000001");
  });

  // The run boundary is the manager being handed a new context, not that
  // context having any particular content. A run whose trace context is empty
  // is still a different run.
  it("mints a new fallback trace id for a run whose trace context is empty", () => {
    const { exporter, captured } = makeCapturingExporter();
    const idGenerator = makeIdGenerator();

    manager.traceContext = { traceparent: TRACEPARENT_RUN_A };

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceId(SEED, idGenerator)
    );

    wrapper.export([createAttemptSpan()], () => {});

    manager.traceContext = {};

    wrapper.export([createAttemptSpan()], () => {});

    expect(captured[1]![0]!.spanContext().traceId).not.toBe(captured[0]![0]!.spanContext().traceId);
  });

  it("keeps one fallback trace id across every export within a run", () => {
    const { exporter, captured } = makeCapturingExporter();
    const idGenerator = makeIdGenerator();

    manager.traceContext = { traceparent: TRACEPARENT_RUN_A };

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceId(SEED, idGenerator)
    );

    wrapper.export([createAttemptSpan()], () => {});
    wrapper.export([createAttemptSpan()], () => {});

    expect(captured[1]![0]!.spanContext().traceId).toBe(captured[0]![0]!.spanContext().traceId);
    expect(idGenerator.count).toBe(0);
  });

  it("leaves external export off when no external trace id was configured", () => {
    const { exporter, captured } = makeCapturingExporter();
    const idGenerator = makeIdGenerator();

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

  // The TracingSDK shares one FallbackExternalTraceId across its span and log
  // wrappers. Giving each its own would remint them independently, so from the
  // second run on, a run's logs would carry a different trace id than its spans
  // and stop correlating in the external backend.
  it("keeps a run's spans and logs on the same id after a remint", () => {
    const spans = makeCapturingExporter();
    const logs = makeCapturingLogExporter();
    const idGenerator = makeIdGenerator();

    manager.traceContext = { traceparent: TRACEPARENT_RUN_A };

    const fallback = new FallbackExternalTraceId(SEED, idGenerator);
    const spanWrapper = new ExternalSpanExporterWrapper(spans.exporter, fallback);
    const logWrapper = new ExternalLogRecordExporterWrapper(logs.exporter, fallback);

    manager.traceContext = { traceparent: TRACEPARENT_RUN_B };

    spanWrapper.export([createAttemptSpan()], () => {});
    logWrapper.export([createLogRecord()], () => {});

    expect(logs.captured[0]![0]!.spanContext!.traceId).toBe(
      spans.captured[0]![0]!.spanContext().traceId
    );
    expect(idGenerator.count).toBe(1);
  });

  // With no manager registered the epoch is a constant, so there are no run
  // boundaries to react to and the id must hold rather than churn per export.
  it("holds the id when no trace context manager is registered", () => {
    const { exporter, captured } = makeCapturingExporter();
    const idGenerator = makeIdGenerator();

    traceContext.disable();

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceId(SEED, idGenerator)
    );

    wrapper.export([createAttemptSpan()], () => {});
    wrapper.export([createAttemptSpan()], () => {});

    expect(captured[1]![0]!.spanContext().traceId).toBe(captured[0]![0]!.spanContext().traceId);
    expect(idGenerator.count).toBe(0);
  });
});
