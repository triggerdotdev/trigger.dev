import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { buildSyntheticTraceForBufferedRun } from "~/v3/mollifier/syntheticTrace.server";
import type { SyntheticRun } from "~/v3/mollifier/readFallback.server";

const NOW = new Date("2026-05-22T10:00:00Z");
const ONE_MS_IN_NS = 1_000_000;

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
    parentSpanId: undefined,
    runtimeEnvironmentId: "env_a",
    engine: "V2",
    workerQueue: undefined,
    queue: undefined,
    concurrencyKey: undefined,
    machinePreset: undefined,
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

describe("buildSyntheticTraceForBufferedRun", () => {
  it("populates the synthesised root span from snapshot identity fields", () => {
    const trace = buildSyntheticTraceForBufferedRun(makeSyntheticRun());
    expect(trace.events).toHaveLength(1);
    const root = trace.events[0];
    expect(root.id).toBe("span_1");
    expect(root.data.message).toBe("hello-world");
    expect(root.data.startTime).toEqual(NOW);
    expect(root.data.isRoot).toBe(true);
    expect(root.data.offset).toBe(0);
    expect(root.data.level).toBe("TRACE");
  });

  it("defaults the span message to 'Task' when the snapshot has no taskIdentifier", () => {
    const trace = buildSyntheticTraceForBufferedRun(
      makeSyntheticRun({ taskIdentifier: undefined })
    );
    expect(trace.events[0].data.message).toBe("Task");
  });

  it("falls back to an empty-string span id when the snapshot has no spanId", () => {
    const trace = buildSyntheticTraceForBufferedRun(
      makeSyntheticRun({ spanId: undefined })
    );
    expect(trace.events[0].id).toBe("");
    // Empty id still marks as root (it matches the rootId fallback).
    expect(trace.events[0].data.isRoot).toBe(true);
  });

  it("renders a QUEUED buffered run as an executing, partial root span", () => {
    const trace = buildSyntheticTraceForBufferedRun(makeSyntheticRun({ status: "QUEUED" }));
    expect(trace.rootSpanStatus).toBe("executing");
    expect(trace.events[0].data.isPartial).toBe(true);
    expect(trace.events[0].data.isError).toBe(false);
    expect(trace.events[0].data.isCancelled).toBe(false);
    // A partial span exposes duration as null (the timeline reads it as
    // "still running"); see syntheticTrace.server.ts duration mapping.
    expect(trace.events[0].data.duration).toBeNull();
  });

  it("renders a CANCELED buffered run as a completed, non-partial cancelled span", () => {
    const trace = buildSyntheticTraceForBufferedRun(
      makeSyntheticRun({ status: "CANCELED", cancelledAt: NOW })
    );
    expect(trace.rootSpanStatus).toBe("completed");
    expect(trace.events[0].data.isPartial).toBe(false);
    expect(trace.events[0].data.isCancelled).toBe(true);
    expect(trace.events[0].data.isError).toBe(false);
    // Non-partial: duration is the span's numeric value (0 here), not null.
    expect(trace.events[0].data.duration).toBe(0);
  });

  it("renders a FAILED buffered run as a failed, non-partial errored span", () => {
    const trace = buildSyntheticTraceForBufferedRun(
      makeSyntheticRun({
        status: "FAILED",
        error: { code: "GATE_REJECTED", message: "buffer rejected the run" },
      })
    );
    expect(trace.rootSpanStatus).toBe("failed");
    expect(trace.events[0].data.isPartial).toBe(false);
    expect(trace.events[0].data.isError).toBe(true);
    expect(trace.events[0].data.isCancelled).toBe(false);
    expect(trace.events[0].data.duration).toBe(0);
  });

  it("floors the trace duration to a minimum of 1ms (in nanoseconds) so the timeline has a positive extent", () => {
    const trace = buildSyntheticTraceForBufferedRun(makeSyntheticRun());
    expect(trace.duration).toBe(ONE_MS_IN_NS);
  });

  it("reports the buffered createdAt as the trace's rootStartedAt and leaves startedAt null", () => {
    const trace = buildSyntheticTraceForBufferedRun(makeSyntheticRun());
    expect(trace.rootStartedAt).toEqual(NOW);
    expect(trace.startedAt).toBeNull();
  });

  it("returns no link or override metadata (buffered traces are single-span)", () => {
    const trace = buildSyntheticTraceForBufferedRun(makeSyntheticRun());
    expect(trace.linkedRunIdBySpanId).toEqual({});
    expect(trace.overridesBySpanId).toBeUndefined();
    expect(trace.queuedDuration).toBeUndefined();
  });

  it("synthesises an empty timeline and keeps raw span events out of the payload", () => {
    const trace = buildSyntheticTraceForBufferedRun(makeSyntheticRun());
    // Raw span events stay server-side (mirrors RunPresenter's payload diet).
    expect(trace.events[0].data).not.toHaveProperty("events");
    expect(trace.events[0].data.timelineEvents).toEqual([]);
  });
});
