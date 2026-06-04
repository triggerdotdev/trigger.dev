import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { buildSyntheticRunHeader } from "~/v3/mollifier/syntheticRunHeader.server";
import type { SyntheticRun } from "~/v3/mollifier/readFallback.server";

const NOW = new Date("2026-05-21T10:00:00Z");
const CANCELLED_AT = new Date("2026-05-21T10:00:30Z");

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

const ENV = {
  id: "env_a",
  organizationId: "org_a",
  type: "DEVELOPMENT" as const,
  slug: "dev",
};

describe("buildSyntheticRunHeader", () => {
  it("returns PENDING / non-final state for a queued buffered run", () => {
    const header = buildSyntheticRunHeader({ run: makeSyntheticRun(), environment: ENV });
    expect(header.status).toBe("PENDING");
    expect(header.isFinished).toBe(false);
    expect(header.completedAt).toBeNull();
  });

  it("reflects CANCELED state from the snapshot so the NavBar and Cancel-button gate update before the drainer materialises", () => {
    const header = buildSyntheticRunHeader({
      run: makeSyntheticRun({ status: "CANCELED", cancelledAt: CANCELLED_AT }),
      environment: ENV,
    });
    // The Cancel button in route.tsx is gated on `!run.isFinished` and the
    // status badge reads `run.status`. Both must flip on buffered-cancel
    // or the user sees a "Pending" badge with a Cancel button on a run
    // that's already cancelled in the snapshot.
    expect(header.status).toBe("CANCELED");
    expect(header.isFinished).toBe(true);
    expect(header.completedAt).toEqual(CANCELLED_AT);
  });

  it("populates completedAt for FAILED runs so the route stops live-reloading and renders as completed", () => {
    // The run-detail route derives `isCompleted` from
    // `run.completedAt !== null` and gates SSE live-reloading on it
    // (`route.tsx:459`, `:551`). Leaving completedAt null for FAILED
    // buffered runs would keep a terminal run live-reloading forever
    // while the badge already says SYSTEM_FAILURE. Symmetric with
    // buildSyntheticSpanRun + ApiRetrieveRunPresenter.
    const header = buildSyntheticRunHeader({
      run: makeSyntheticRun({ status: "FAILED" }),
      environment: ENV,
    });
    expect(header.status).toBe("SYSTEM_FAILURE");
    expect(header.isFinished).toBe(true);
    expect(header.completedAt).toEqual(NOW);
  });

  it("forwards identity and environment fields from the snapshot", () => {
    const header = buildSyntheticRunHeader({ run: makeSyntheticRun(), environment: ENV });
    expect(header.friendlyId).toBe("run_friendly_1");
    // `id` mirrors RunPresenter.getRun (the PG path) which puts the
    // internal cuid in this field. SyntheticRun.id is the cuid; the
    // header must surface it (not the friendlyId).
    expect(header.id).toBe("run_internal_1");
    expect(header.traceId).toBe("trace_1");
    expect(header.spanId).toBe("span_1");
    expect(header.environment).toMatchObject({
      id: "env_a",
      organizationId: "org_a",
      type: "DEVELOPMENT",
      slug: "dev",
    });
  });

  it("falls back to empty strings when the snapshot has no trace/span ids", () => {
    const header = buildSyntheticRunHeader({
      run: makeSyntheticRun({ traceId: undefined, spanId: undefined }),
      environment: ENV,
    });
    expect(header.traceId).toBe("");
    expect(header.spanId).toBe("");
  });
});
