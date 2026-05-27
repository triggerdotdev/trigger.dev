import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { buildSyntheticSpanRun } from "~/v3/mollifier/syntheticSpanRun.server";
import type { SyntheticRun } from "~/v3/mollifier/readFallback.server";

const NOW = new Date("2026-05-21T10:00:00Z");

function makeSyntheticRun(overrides: Partial<SyntheticRun> = {}): SyntheticRun {
  return {
    id: "run_internal_1",
    friendlyId: "run_friendly_1",
    status: "QUEUED",
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
    tags: ["a", "b"],
    runTags: ["a", "b"],
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

const ENV = {
  id: "env_a",
  slug: "dev",
  type: "DEVELOPMENT" as const,
};

describe("buildSyntheticSpanRun", () => {
  it("populates the core identity fields from the snapshot", async () => {
    const synth = await buildSyntheticSpanRun({ run: makeSyntheticRun(), environment: ENV });
    expect(synth.id).toBe("run_internal_1");
    expect(synth.friendlyId).toBe("run_friendly_1");
    expect(synth.taskIdentifier).toBe("hello-world");
    expect(synth.traceId).toBe("trace_1");
    expect(synth.spanId).toBe("span_1");
    expect(synth.environmentId).toBe("env_a");
    expect(synth.engine).toBe("V2");
    expect(synth.workerQueue).toBe("worker-queue-1");
  });

  it("reports PENDING status and the non-final flags", async () => {
    const synth = await buildSyntheticSpanRun({ run: makeSyntheticRun(), environment: ENV });
    expect(synth.status).toBe("PENDING");
    expect(synth.isFinished).toBe(false);
    expect(synth.isRunning).toBe(false);
    expect(synth.isError).toBe(false);
    expect(synth.startedAt).toBeNull();
    expect(synth.completedAt).toBeNull();
  });

  it("pretty-prints the JSON payload from the snapshot", async () => {
    const synth = await buildSyntheticSpanRun({
      run: makeSyntheticRun({ payload: { message: "hi" }, payloadType: "application/json" }),
      environment: ENV,
    });
    // prettyPrintPacket round-trips JSON with 2-space indent.
    expect(synth.payload).toContain('"message": "hi"');
    expect(synth.payloadType).toBe("application/json");
  });

  it("forwards runTags onto `tags` exactly", async () => {
    const synth = await buildSyntheticSpanRun({
      run: makeSyntheticRun({ runTags: ["alpha", "beta"] }),
      environment: ENV,
    });
    expect(synth.tags).toEqual(["alpha", "beta"]);
  });

  it("classifies the queue name as custom when it does not start with 'task/'", async () => {
    const taskQueue = await buildSyntheticSpanRun({
      run: makeSyntheticRun({ queue: "task/hello-world" }),
      environment: ENV,
    });
    expect(taskQueue.queue.isCustomQueue).toBe(false);

    const customQueue = await buildSyntheticSpanRun({
      run: makeSyntheticRun({ queue: "my-custom" }),
      environment: ENV,
    });
    expect(customQueue.queue.isCustomQueue).toBe(true);
  });

  it("derives idempotency status from the snapshot key/options", async () => {
    const withKey = await buildSyntheticSpanRun({
      run: makeSyntheticRun({ idempotencyKey: "abc", idempotencyKeyOptions: ["scope"] }),
      environment: ENV,
    });
    expect(withKey.idempotencyKey).toBe("abc");
    expect(withKey.idempotencyKeyStatus).toBe("active");

    const noKey = await buildSyntheticSpanRun({
      run: makeSyntheticRun({ idempotencyKey: undefined, idempotencyKeyOptions: undefined }),
      environment: ENV,
    });
    expect(noKey.idempotencyKeyStatus).toBeUndefined();
  });

  it("omits relationships even when parent/root friendlyIds are present, since the snapshot lacks their spanId/taskIdentifier", async () => {
    const synth = await buildSyntheticSpanRun({
      run: makeSyntheticRun({
        parentTaskRunFriendlyId: "run_parent",
        rootTaskRunFriendlyId: "run_root",
      }),
      environment: ENV,
    });
    expect(synth.relationships.parent).toBeUndefined();
    expect(synth.relationships.root).toBeUndefined();
  });

  it("returns no relationship objects when the snapshot has no parent/root", async () => {
    const synth = await buildSyntheticSpanRun({
      run: makeSyntheticRun(),
      environment: ENV,
    });
    expect(synth.relationships.parent).toBeUndefined();
    expect(synth.relationships.root).toBeUndefined();
  });

  it("reflects a buffered CANCELED run as a finished, cancelled terminal state", async () => {
    const synth = await buildSyntheticSpanRun({
      run: makeSyntheticRun({
        status: "CANCELED",
        cancelledAt: NOW,
        cancelReason: "cancelled by user",
      }),
      environment: ENV,
    });
    expect(synth.status).toBe("CANCELED");
    expect(synth.statusReason).toBe("cancelled by user");
    expect(synth.isFinished).toBe(true);
    expect(synth.isError).toBe(false);
    expect(synth.completedAt).toEqual(NOW);
  });

  it("reflects a buffered FAILED run as a finished, errored SYSTEM_FAILURE", async () => {
    const synth = await buildSyntheticSpanRun({
      run: makeSyntheticRun({
        status: "FAILED",
        error: { code: "GATE_REJECTED", message: "buffer rejected the run" },
      }),
      environment: ENV,
    });
    expect(synth.status).toBe("SYSTEM_FAILURE");
    expect(synth.isFinished).toBe(true);
    expect(synth.isError).toBe(true);
    expect(synth.statusReason).toBe("buffer rejected the run");
    expect(synth.error).toEqual({
      type: "STRING_ERROR",
      raw: "GATE_REJECTED: buffer rejected the run",
    });
  });

  it("flags the synthetic run as 'not cached' since cache lookup did not match it", async () => {
    const synth = await buildSyntheticSpanRun({ run: makeSyntheticRun(), environment: ENV });
    expect(synth.isCached).toBe(false);
  });
});
