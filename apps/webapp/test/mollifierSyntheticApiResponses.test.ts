import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import {
  buildSyntheticSpanDetailBody,
  buildSyntheticTraceBody,
} from "~/v3/mollifier/syntheticApiResponses.server";
import type { SyntheticRun } from "~/v3/mollifier/readFallback.server";

const NOW = new Date("2026-05-23T10:00:00Z");

function makeSyntheticRun(overrides: Partial<SyntheticRun> = {}): SyntheticRun {
  return {
    id: "run_internal_1",
    friendlyId: "run_friendly_1",
    status: "QUEUED",
    cancelledAt: undefined,
    cancelReason: undefined,
    delayUntil: undefined,
    taskIdentifier: "hello-world",
    createdAt: NOW,
    payload: undefined,
    payloadType: undefined,
    metadata: undefined,
    metadataType: undefined,
    seedMetadata: undefined,
    seedMetadataType: undefined,
    idempotencyKey: undefined,
    idempotencyKeyOptions: undefined,
    isTest: false,
    depth: 0,
    ttl: undefined,
    tags: [],
    runTags: [],
    lockedToVersion: undefined,
    resumeParentOnCompletion: false,
    parentTaskRunId: undefined,
    traceId: "trace_1",
    spanId: "span_1",
    parentSpanId: "span_parent",
    runtimeEnvironmentId: "env_a",
    engine: "V2",
    workerQueue: undefined,
    queue: "task/hello-world",
    concurrencyKey: undefined,
    machinePreset: "small-1x",
    realtimeStreamsVersion: undefined,
    maxAttempts: undefined,
    maxDurationInSeconds: undefined,
    replayedFromTaskRunFriendlyId: undefined,
    annotations: undefined,
    traceContext: undefined,
    scheduleId: undefined,
    batchId: undefined,
    parentTaskRunFriendlyId: undefined,
    rootTaskRunFriendlyId: undefined,
    ...overrides,
  };
}

describe("buildSyntheticSpanDetailBody", () => {
  it("populates identity fields from the buffered run", () => {
    const body = buildSyntheticSpanDetailBody(makeSyntheticRun());
    expect(body.spanId).toBe("span_1");
    expect(body.parentId).toBe("span_parent");
    expect(body.runId).toBe("run_friendly_1");
    expect(body.message).toBe("hello-world");
    expect(body.level).toBe("TRACE");
    expect(body.startTime).toEqual(NOW);
    expect(body.durationMs).toBe(0);
  });

  it("defaults parentId to null when the buffered run has no parentSpanId", () => {
    const body = buildSyntheticSpanDetailBody(makeSyntheticRun({ parentSpanId: undefined }));
    expect(body.parentId).toBeNull();
  });

  it("defaults message to '' when the buffered run has no taskIdentifier", () => {
    const body = buildSyntheticSpanDetailBody(
      makeSyntheticRun({ taskIdentifier: undefined })
    );
    expect(body.message).toBe("");
  });

  it("renders a QUEUED buffered run as a still-partial, non-error, non-cancelled span", () => {
    const body = buildSyntheticSpanDetailBody(makeSyntheticRun({ status: "QUEUED" }));
    expect(body.isPartial).toBe(true);
    expect(body.isError).toBe(false);
    expect(body.isCancelled).toBe(false);
  });

  it("renders a CANCELED buffered run as a non-partial, non-error, cancelled span", () => {
    const body = buildSyntheticSpanDetailBody(makeSyntheticRun({ status: "CANCELED" }));
    expect(body.isPartial).toBe(false);
    expect(body.isError).toBe(false);
    expect(body.isCancelled).toBe(true);
  });

  it("renders a FAILED buffered run as a non-partial, errored, non-cancelled span", () => {
    // Regression: a FAILED buffered run used to slip through as
    // `isPartial: true, isError: false`, telling SDK pollers it was still
    // executing.
    const body = buildSyntheticSpanDetailBody(makeSyntheticRun({ status: "FAILED" }));
    expect(body.isPartial).toBe(false);
    expect(body.isError).toBe(true);
    expect(body.isCancelled).toBe(false);
  });
});

describe("buildSyntheticTraceBody", () => {
  it("envelopes the synthesised root span under `trace.rootSpan` with the buffered traceId", () => {
    const body = buildSyntheticTraceBody(makeSyntheticRun());
    expect(body.trace.traceId).toBe("trace_1");
    expect(body.trace.rootSpan.id).toBe("span_1");
    expect(body.trace.rootSpan.runId).toBe("run_friendly_1");
    expect(body.trace.rootSpan.children).toEqual([]);
    expect(body.trace.rootSpan.data.events).toEqual([]);
  });

  it("falls back to empty strings when traceId / spanId are absent from the snapshot", () => {
    const body = buildSyntheticTraceBody(
      makeSyntheticRun({ traceId: undefined, spanId: undefined })
    );
    expect(body.trace.traceId).toBe("");
    expect(body.trace.rootSpan.id).toBe("");
  });

  it("passes through queueName and machinePreset from the snapshot", () => {
    const body = buildSyntheticTraceBody(makeSyntheticRun());
    expect(body.trace.rootSpan.data.queueName).toBe("task/hello-world");
    expect(body.trace.rootSpan.data.machinePreset).toBe("small-1x");
  });

  it("defaults taskSlug to undefined when the buffered run has no taskIdentifier", () => {
    const body = buildSyntheticTraceBody(makeSyntheticRun({ taskIdentifier: undefined }));
    expect(body.trace.rootSpan.data.taskSlug).toBeUndefined();
    expect(body.trace.rootSpan.data.message).toBe("");
  });

  it("renders a QUEUED buffered run as a partial, non-error, non-cancelled root span", () => {
    const body = buildSyntheticTraceBody(makeSyntheticRun({ status: "QUEUED" }));
    expect(body.trace.rootSpan.data.isPartial).toBe(true);
    expect(body.trace.rootSpan.data.isError).toBe(false);
    expect(body.trace.rootSpan.data.isCancelled).toBe(false);
  });

  it("renders a CANCELED buffered run as a non-partial, non-error, cancelled root span", () => {
    const body = buildSyntheticTraceBody(makeSyntheticRun({ status: "CANCELED" }));
    expect(body.trace.rootSpan.data.isPartial).toBe(false);
    expect(body.trace.rootSpan.data.isError).toBe(false);
    expect(body.trace.rootSpan.data.isCancelled).toBe(true);
  });

  it("renders a FAILED buffered run as a non-partial, errored, non-cancelled root span", () => {
    // Regression: a FAILED buffered run used to render with
    // `isPartial: true, isError: false`, masking the failure from SDK
    // consumers.
    const body = buildSyntheticTraceBody(makeSyntheticRun({ status: "FAILED" }));
    expect(body.trace.rootSpan.data.isPartial).toBe(false);
    expect(body.trace.rootSpan.data.isError).toBe(true);
    expect(body.trace.rootSpan.data.isCancelled).toBe(false);
  });
});
