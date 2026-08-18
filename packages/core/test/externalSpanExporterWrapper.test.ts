import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-node";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ExternalLogRecordExporterWrapper,
  ExternalSpanExporterWrapper,
  FallbackExternalTraceIds,
  MAX_TRACKED_INTERNAL_TRACES,
} from "../src/v3/otel/tracingSDK.js";
import { SemanticInternalAttributes } from "../src/v3/semanticInternalAttributes.js";
import { traceContext } from "../src/v3/trace-context-api.js";
import { StandardTraceContextManager } from "../src/v3/traceContext/manager.js";

const TRACEPARENT_RUN_A = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01";
const TRACEPARENT_RUN_B = "00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-2222222222222222-01";
const SEED = "ffffffffffffffffffffffffffffffff";
// Every span and log record of one run shares the run's internal trace id.
const INTERNAL_TRACE_RUN_A = "cccccccccccccccccccccccccccccccc";
const INTERNAL_TRACE_RUN_B = "dddddddddddddddddddddddddddddddd";

function createAttemptSpan(internalTraceId = INTERNAL_TRACE_RUN_A): ReadableSpan {
  const spanCtx = {
    traceId: internalTraceId,
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

function createLogRecord(internalTraceId = INTERNAL_TRACE_RUN_A): ReadableLogRecord {
  return {
    body: "hello",
    attributes: {},
    spanContext: {
      traceId: internalTraceId,
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

    const wrapper = new ExternalSpanExporterWrapper(exporter, new FallbackExternalTraceIds(SEED));

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
  it("gives each run its own fallback trace id when there is no external context", () => {
    const { exporter, captured } = makeCapturingExporter();
    const idGenerator = makeIdGenerator();

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceIds(SEED, idGenerator)
    );

    wrapper.export([createAttemptSpan(INTERNAL_TRACE_RUN_A)], () => {});
    // A second run on the same warm process.
    wrapper.export([createAttemptSpan(INTERNAL_TRACE_RUN_B)], () => {});

    const runATraceId = captured[0]![0]!.spanContext().traceId;
    const runBTraceId = captured[1]![0]!.spanContext().traceId;

    expect(runATraceId).toBe(SEED);
    expect(runBTraceId).not.toBe(runATraceId);
    expect(runBTraceId).toBe("00000000000000000000000000000001");
  });

  it("keeps one fallback trace id across every export within a run", () => {
    const { exporter, captured } = makeCapturingExporter();
    const idGenerator = makeIdGenerator();

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceIds(SEED, idGenerator)
    );

    wrapper.export([createAttemptSpan()], () => {});
    wrapper.export([createAttemptSpan()], () => {});

    expect(captured[1]![0]!.spanContext().traceId).toBe(captured[0]![0]!.spanContext().traceId);
    expect(idGenerator.count).toBe(0);
  });

  // Batch processors drain asynchronously, so a run's records are routinely
  // exported after the next run has already started. Deciding the id from
  // ambient state at that moment would stamp the earlier run's records with the
  // later run's id, merging exactly the traces this is meant to separate.
  //
  // Drives the span and log wrappers together: the TracingSDK shares one
  // instance between them, and a run's spans and logs have to land on one trace.
  it("stamps records with their own run's id even when exported after the next run started", () => {
    const spans = makeCapturingExporter();
    const logs = makeCapturingLogExporter();
    const idGenerator = makeIdGenerator();

    const fallback = new FallbackExternalTraceIds(SEED, idGenerator);
    const spanWrapper = new ExternalSpanExporterWrapper(spans.exporter, fallback);
    const logWrapper = new ExternalLogRecordExporterWrapper(logs.exporter, fallback);

    // Run B is underway and has already exported. Its ambient context has no
    // `external` key, which is what a run on the fallback path looks like, so
    // `getExternalTraceContext()` stays undefined throughout: the point is that
    // the run currently in scope must not influence the records below at all.
    spanWrapper.export([createAttemptSpan(INTERNAL_TRACE_RUN_B)], () => {});
    manager.traceContext = { traceparent: TRACEPARENT_RUN_B };

    // Run A's queued records only drain now.
    spanWrapper.export([createAttemptSpan(INTERNAL_TRACE_RUN_A)], () => {});
    logWrapper.export([createLogRecord(INTERNAL_TRACE_RUN_A)], () => {});

    const runBTraceId = spans.captured[0]![0]!.spanContext().traceId;
    const lateRunASpanId = spans.captured[1]![0]!.spanContext().traceId;
    const lateRunALogId = logs.captured[0]![0]!.spanContext!.traceId;

    expect(lateRunASpanId).not.toBe(runBTraceId);
    expect(lateRunALogId).toBe(lateRunASpanId);
  });

  it("leaves external export off when no external trace id was configured", () => {
    const { exporter, captured } = makeCapturingExporter();
    const idGenerator = makeIdGenerator();

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceIds("", idGenerator)
    );

    wrapper.export([createAttemptSpan()], () => {});

    // Minting an id here would switch external export on for a deployment that
    // never asked for it.
    expect(captured[0]).toHaveLength(0);
  });

  // Instrumentation can start root spans outside a run's async context, each
  // its own internal trace, so a run can be alive while the map churns. Evicting
  // by insertion order would drop the run still using its id and split it across
  // two external traces.
  it("keeps the id of a run that is still exporting while other traces fill the map", () => {
    const { exporter, captured } = makeCapturingExporter();

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceIds(SEED, makeIdGenerator())
    );

    const liveRun = "aa000000000000000000000000000000";
    wrapper.export([createAttemptSpan(liveRun)], () => {});

    for (let i = 0; i < MAX_TRACKED_INTERNAL_TRACES * 2; i++) {
      wrapper.export([createAttemptSpan(`bb${`${i}`.padStart(30, "0")}`)], () => {});
      // The run is still going, so it keeps exporting alongside the noise.
      wrapper.export([createAttemptSpan(liveRun)], () => {});
    }

    expect(captured.at(-1)![0]!.spanContext().traceId).toBe(captured[0]![0]!.spanContext().traceId);
  });

  it("passes through a log record emitted outside a span, which has no spanContext", () => {
    const logs = makeCapturingLogExporter();

    const wrapper = new ExternalLogRecordExporterWrapper(
      logs.exporter,
      new FallbackExternalTraceIds(SEED)
    );

    const record = { body: "hello", attributes: {} } as unknown as ReadableLogRecord;

    expect(() => wrapper.export([record], () => {})).not.toThrow();
    expect(logs.captured[0]).toEqual([record]);
  });

  // A warm process is long-lived, so the map that remembers each run's id has
  // to be bounded rather than growing for the life of the worker.
  it("bounds how many runs it remembers", () => {
    const { exporter, captured } = makeCapturingExporter();
    const idGenerator = makeIdGenerator();

    const wrapper = new ExternalSpanExporterWrapper(
      exporter,
      new FallbackExternalTraceIds(SEED, idGenerator)
    );

    const firstRun = "aa000000000000000000000000000000";
    wrapper.export([createAttemptSpan(firstRun)], () => {});

    for (let i = 0; i < MAX_TRACKED_INTERNAL_TRACES; i++) {
      wrapper.export([createAttemptSpan(`bb${`${i}`.padStart(30, "0")}`)], () => {});
    }

    // Evicted, so it is treated as a run never seen before.
    wrapper.export([createAttemptSpan(firstRun)], () => {});

    expect(captured.at(-1)![0]!.spanContext().traceId).not.toBe(
      captured[0]![0]!.spanContext().traceId
    );
  });
});
