import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { buildSyntheticReplayTaskRun } from "~/v3/mollifier/syntheticReplayTaskRun.server";
import type { SyntheticRun } from "~/v3/mollifier/readFallback.server";

const NOW = new Date("2026-05-21T10:00:00Z");

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
    payload: { message: "hi" },
    payloadType: "application/json",
    metadata: undefined,
    metadataType: undefined,
    seedMetadata: undefined,
    seedMetadataType: undefined,
    idempotencyKey: undefined,
    idempotencyKeyOptions: undefined,
    isTest: false,
    depth: 0,
    ttl: "10m",
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
    workerQueue: "worker-queue-1",
    queue: "task/hello-world",
    concurrencyKey: undefined,
    machinePreset: "small-1x",
    realtimeStreamsVersion: "v1",
    maxAttempts: 3,
    maxDurationInSeconds: 3600,
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

const ENV_ROW = {
  slug: "dev",
  project: { slug: "hello-world", organization: { slug: "references" } },
};

describe("buildSyntheticReplayTaskRun", () => {
  it("returns the adapted TaskRun shape when traceId and spanId are present", () => {
    const taskRun = buildSyntheticReplayTaskRun({
      synthetic: makeSyntheticRun(),
      envRow: ENV_ROW,
    });
    expect(taskRun).not.toBeNull();
    expect(taskRun!.traceId).toBe("trace_1");
    expect(taskRun!.spanId).toBe("span_1");
    expect(taskRun!.project.slug).toBe("hello-world");
    expect(taskRun!.project.organization.slug).toBe("references");
    expect(taskRun!.runtimeEnvironment.slug).toBe("dev");
  });

  it("returns null when the snapshot has no traceId", () => {
    // ReplayTaskRunService builds `00-${traceId}-${spanId}-01` without
    // guarding for undefined. Falling through with a missing traceId
    // would emit `00-undefined-...-01`, an invalid W3C traceparent that
    // OTel silently drops, breaking the replayed run's trace linkage to
    // the original. The helper must refuse rather than degrade silently.
    const taskRun = buildSyntheticReplayTaskRun({
      synthetic: makeSyntheticRun({ traceId: undefined }),
      envRow: ENV_ROW,
    });
    expect(taskRun).toBeNull();
  });

  it("returns null when the snapshot has no spanId", () => {
    const taskRun = buildSyntheticReplayTaskRun({
      synthetic: makeSyntheticRun({ spanId: undefined }),
      envRow: ENV_ROW,
    });
    expect(taskRun).toBeNull();
  });

  it("returns null when both traceId and spanId are missing", () => {
    const taskRun = buildSyntheticReplayTaskRun({
      synthetic: makeSyntheticRun({ traceId: undefined, spanId: undefined }),
      envRow: ENV_ROW,
    });
    expect(taskRun).toBeNull();
  });
});
