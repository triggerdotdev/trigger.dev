import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import {
  synthesiseFoundRunFromBuffer,
  type FoundRun,
} from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import type { SyntheticRun } from "~/v3/mollifier/readFallback.server";

const NOW = new Date("2026-05-24T10:00:00Z");

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
    payload: '{"hello":"world"}',
    payloadType: "application/json",
    metadata: undefined,
    metadataType: undefined,
    seedMetadata: undefined,
    seedMetadataType: undefined,
    idempotencyKey: undefined,
    idempotencyKeyOptions: undefined,
    isTest: false,
    depth: 0,
    ttl: undefined,
    tags: ["alpha", "beta"],
    runTags: ["alpha", "beta"],
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

describe("synthesiseFoundRunFromBuffer", () => {
  it("populates internal id and friendlyId so downstream logging keys off the cuid", () => {
    const found: FoundRun = synthesiseFoundRunFromBuffer(makeSyntheticRun());
    expect(found.id).toBe("run_internal_1");
    expect(found.friendlyId).toBe("run_friendly_1");
  });

  it("marks the synth as isBuffered=true so callers like the events route can short-circuit ClickHouse lookups", () => {
    // The PG path of `findRun` sets `isBuffered: false`; the buffered
    // path goes through `synthesiseFoundRunFromBuffer` and must set
    // `isBuffered: true` so consumers (e.g. the events endpoint) can
    // skip queries that are guaranteed to return empty for buffered
    // runs without rewriting them around surrogate signals like
    // `traceId === ""`.
    const found: FoundRun = synthesiseFoundRunFromBuffer(makeSyntheticRun());
    expect(found.isBuffered).toBe(true);
  });

  it("forwards scheduleId from the snapshot so resolveSchedule can hydrate the schedule field", () => {
    // Regression: scheduleId was previously hardcoded to null, dropping the
    // schedule metadata for buffered scheduled runs even though the snapshot
    // carries it (readFallback.server.ts extracts snapshot.scheduleId).
    const found = synthesiseFoundRunFromBuffer(
      makeSyntheticRun({ scheduleId: "schedule_internal_42" })
    );
    expect(found.scheduleId).toBe("schedule_internal_42");
  });

  it("leaves scheduleId null when the snapshot has no scheduleId (non-scheduled trigger)", () => {
    const found = synthesiseFoundRunFromBuffer(makeSyntheticRun());
    expect(found.scheduleId).toBeNull();
  });

  it("reconstructs batch.friendlyId from snapshot.batchId so batch-scoped JWTs authorise", () => {
    // Regression: batch was previously hardcoded to null, so the
    // route-authorization callbacks (which read run.batch?.friendlyId)
    // skipped pushing the batch resource — a batch-scoped JWT 403'd on
    // buffered batched runs.
    const found = synthesiseFoundRunFromBuffer(
      // BatchId.toFriendlyId encodes the internal id with a "batch_" prefix.
      makeSyntheticRun({ batchId: "abcdefghijklmnopqrstuvwx" })
    );
    expect(found.batch).not.toBeNull();
    expect(found.batch!.id).toBe("abcdefghijklmnopqrstuvwx");
    expect(found.batch!.friendlyId).toMatch(/^batch_/);
  });

  it("leaves batch null when the snapshot has no batchId (non-batched run)", () => {
    const found = synthesiseFoundRunFromBuffer(makeSyntheticRun());
    expect(found.batch).toBeNull();
  });

  it("defaults workerQueue to '' so createCommonRunStructure coerces region to undefined", () => {
    // Regression: workerQueue previously defaulted to "main", which fed
    // through `run.workerQueue || undefined` as the API response's
    // `region` — advertising a not-yet-assigned region.
    const found = synthesiseFoundRunFromBuffer(makeSyntheticRun({ workerQueue: undefined }));
    expect(found.workerQueue).toBe("");
  });

  it("passes through an explicit workerQueue from the snapshot unchanged", () => {
    const found = synthesiseFoundRunFromBuffer(makeSyntheticRun({ workerQueue: "us-east-1" }));
    expect(found.workerQueue).toBe("us-east-1");
  });

  it("maps buffered FAILED to SYSTEM_FAILURE so the API surfaces the failure", () => {
    const found = synthesiseFoundRunFromBuffer(
      makeSyntheticRun({
        status: "FAILED",
        error: { code: "GATE_REJECTED", message: "buffer rejected the run" },
      })
    );
    expect(found.status).toBe("SYSTEM_FAILURE");
    expect(found.error).toEqual({
      type: "STRING_ERROR",
      raw: "GATE_REJECTED: buffer rejected the run",
    });
  });

  it("maps buffered CANCELED to CANCELED with completedAt populated from cancelledAt", () => {
    const cancelledAt = new Date("2026-05-24T10:05:00Z");
    const found = synthesiseFoundRunFromBuffer(
      makeSyntheticRun({ status: "CANCELED", cancelledAt })
    );
    expect(found.status).toBe("CANCELED");
    expect(found.completedAt).toEqual(cancelledAt);
  });

  it("maps buffered QUEUED to PENDING with no error and no completedAt", () => {
    const found = synthesiseFoundRunFromBuffer(makeSyntheticRun({ status: "QUEUED" }));
    expect(found.status).toBe("PENDING");
    expect(found.error).toBeNull();
    expect(found.completedAt).toBeNull();
  });

  it("passes through a string snapshot.metadata unchanged", () => {
    const found = synthesiseFoundRunFromBuffer(
      makeSyntheticRun({ metadata: '{"customer":"acme"}' })
    );
    expect(found.metadata).toBe('{"customer":"acme"}');
  });

  it("defensively coerces a non-string snapshot.metadata to a JSON string instead of dropping it silently", () => {
    // Production never writes non-string metadata, but if the snapshot
    // shape drifts we'd rather see the value (with a warn log) than have
    // it disappear.
    const found = synthesiseFoundRunFromBuffer(
      makeSyntheticRun({ metadata: { customer: "acme" } })
    );
    expect(found.metadata).toBe('{"customer":"acme"}');
  });

  it("defaults idempotencyKey / idempotencyKeyOptions to null when absent", () => {
    const found = synthesiseFoundRunFromBuffer(makeSyntheticRun());
    expect(found.idempotencyKey).toBeNull();
    expect(found.idempotencyKeyOptions).toBeNull();
  });

  it("zeroes execution-state fields that aren't meaningful for a buffered run", () => {
    const found = synthesiseFoundRunFromBuffer(makeSyntheticRun());
    expect(found.startedAt).toBeNull();
    expect(found.attempts).toEqual([]);
    expect(found.attemptNumber).toBeNull();
    expect(found.parentTaskRun).toBeNull();
    expect(found.rootTaskRun).toBeNull();
    expect(found.childRuns).toEqual([]);
    expect(found.output).toBeNull();
    expect(found.costInCents).toBe(0);
    expect(found.baseCostInCents).toBe(0);
    expect(found.usageDurationMs).toBe(0);
  });

  it("forwards runTags from the snapshot tags array", () => {
    // Use distinct values for `tags` and `runTags` so the assertion
    // actually pins the mapping. With the fixture's previous
    // `runTags` default matching the same `["alpha", "beta"]` input,
    // this test would have passed even if synthesiseFoundRunFromBuffer
    // accidentally read `runTags` instead of `tags`.
    const found = synthesiseFoundRunFromBuffer(
      makeSyntheticRun({
        tags: ["from-tags"],
        runTags: ["stale-run-tags"],
      })
    );
    expect(found.runTags).toEqual(["from-tags"]);
  });

  it("pins engine to V2 and taskEventStore to taskEvent (only valid values for a buffered run)", () => {
    const found = synthesiseFoundRunFromBuffer(makeSyntheticRun());
    expect(found.engine).toBe("V2");
    expect(found.taskEventStore).toBe("taskEvent");
  });
});
