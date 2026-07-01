import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentById: vi.fn(async () => ({
    id: "env_1",
    type: "PRODUCTION",
    archivedAt: null,
  })),
}));

const triggerCall = vi.fn(async () => ({
  run: { id: "run_new", friendlyId: "run_new_friendly" },
  isCached: false,
}));

vi.mock("~/v3/services/triggerTask.server", () => ({
  TriggerTaskService: class {
    call = triggerCall;
  },
  OutOfEntitlementError: class OutOfEntitlementError extends Error {},
}));

import { ReplayTaskRunService } from "~/v3/services/replayTaskRun.server";

const SOURCE_RUN = {
  id: "run_source_internal",
  friendlyId: "run_source_friendly",
  taskIdentifier: "hello-world",
  runtimeEnvironmentId: "env_1",
  payload: JSON.stringify({ message: "hi" }),
  payloadType: "application/json",
  seedMetadata: null,
  seedMetadataType: "application/json",
  runTags: [],
  queue: "task/hello-world",
  workerQueue: "worker-queue-1",
  concurrencyKey: null,
  machinePreset: "small-1x",
  isTest: false,
  engine: "V2",
  region: null,
  traceId: "trace_1",
  spanId: "span_1",
  realtimeStreamsVersion: "v1",
} as any;

function makeFakePrisma() {
  return {
    runtimeEnvironment: {
      findFirstOrThrow: vi.fn(async () => ({ id: "env_1", type: "PRODUCTION" })),
    },
    taskQueue: {
      findFirst: vi.fn(async () => null),
    },
  } as any;
}

describe("ReplayTaskRunService idempotency (TRI-10467 fix #3)", () => {
  beforeEach(() => {
    triggerCall.mockClear();
  });

  it("sets a stable idempotency key for bulk replay source runs", async () => {
    const service = new ReplayTaskRunService(makeFakePrisma());

    await service.call(SOURCE_RUN, { bulkActionId: "bulk_1", triggerSource: "dashboard" });

    expect(triggerCall.mock.calls[0][2].options.idempotencyKey).toBe(
      "bulk-replay:bulk_1:run_source_internal"
    );
  });
});
