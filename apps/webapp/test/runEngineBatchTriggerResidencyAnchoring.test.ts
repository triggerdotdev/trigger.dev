// REGRESSION: batch + items must be co-resident (TaskRun.batchId FKs into BatchTaskRun on the
// run-ops NEW DB). RunEngineBatchTriggerService (api.v2.tasks.batch.ts) must anchor each item's
// mint on the BATCH's own friendlyId, like batchTriggerV3.server.ts's mintChildFriendlyId does,
// not re-resolve the per-org flag (which can flip between batch creation and async processing).
// Covers BOTH the happy path (item minted directly) AND the failure branch (pre-failed run via
// TriggerFailedTaskService), in BOTH residency directions. Drives the real `processBatchTaskRun`
// entrypoint with a fake `_engine` (no DB/Redis needed) and captures the trigger-pipeline inputs.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findEnvironmentById: vi.fn(),
  triggerTaskServiceCall: vi.fn(),
  triggerFailedTaskCall: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
  runOpsNewReplica: {},
  runOpsLegacyReplica: {},
}));

vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentById: mocks.findEnvironmentById,
}));

vi.mock("~/v3/services/triggerTask.server", () => ({
  TriggerTaskService: class {
    call(...args: unknown[]) {
      return mocks.triggerTaskServiceCall(...args);
    }
  },
}));

vi.mock("~/runEngine/services/triggerFailedTask.server", () => ({
  TriggerFailedTaskService: class {
    call(...args: unknown[]) {
      return mocks.triggerFailedTaskCall(...args);
    }
  },
}));

import {
  BatchId,
  classifyKind,
  generateRunOpsId,
  ownerEngine,
} from "@trigger.dev/core/v3/isomorphic";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { RunEngineBatchTriggerService } from "~/runEngine/services/batchTrigger.server";

vi.setConfig({ testTimeout: 30_000 });

const environment = {
  id: "env_1",
  organizationId: "org_1",
  organization: { featureFlags: {} },
} as unknown as AuthenticatedEnvironment;

function makeBatch(batchFriendlyId: string) {
  return {
    id: "batch_internal_1",
    friendlyId: batchFriendlyId,
    runtimeEnvironmentId: "env_1",
    runCount: 1,
    payload: JSON.stringify([{ task: "some-task", payload: "{}" }]),
    payloadType: "application/json",
    options: {},
  };
}

function makeFakeEngine(batch: ReturnType<typeof makeBatch>) {
  return {
    runStore: {
      findBatchTaskRunById: vi.fn().mockResolvedValue(batch),
      updateBatchTaskRun: vi.fn().mockResolvedValue({ processingJobsCount: 1, runCount: 1 }),
    },
    tryCompleteBatch: vi.fn().mockResolvedValue(undefined),
  };
}

async function processBatch(batchFriendlyId: string) {
  const batch = makeBatch(batchFriendlyId);
  const service = new RunEngineBatchTriggerService(
    "sequential",
    {} as any,
    makeFakeEngine(batch) as any
  );
  await service.processBatchTaskRun({
    batchId: batch.id,
    processingId: "0",
    range: { start: 0, count: 50 },
    attemptCount: 0,
    strategy: "sequential",
  });
}

function anchoredRunFriendlyIdArg(mock: ReturnType<typeof vi.fn>): string | undefined {
  const [, , , options] = mock.mock.calls[0] as [
    unknown,
    unknown,
    unknown,
    { runFriendlyId?: string } | undefined,
  ];
  return options?.runFriendlyId;
}

beforeEach(() => {
  mocks.findEnvironmentById.mockReset().mockResolvedValue(environment);
  mocks.triggerTaskServiceCall.mockReset();
  mocks.triggerFailedTaskCall.mockReset();
});

describe("RunEngineBatchTriggerService — batch item residency anchoring", () => {
  // Split is off in this test, so re-resolving the per-org flag would yield cuid — a NEW anchor
  // yielding runOpsId proves the anchor wins over what the flag would say.
  it("happy path: a run-ops (NEW) batch anchor mints a run-ops item, overriding what the flag would resolve", async () => {
    const batchFriendlyId = BatchId.toFriendlyId(generateRunOpsId());
    expect(ownerEngine(batchFriendlyId)).toBe("NEW");

    mocks.triggerTaskServiceCall.mockResolvedValue({
      run: { id: "run_internal_1", friendlyId: "run_fake", status: "PENDING" },
      isCached: false,
    });

    await processBatch(batchFriendlyId);

    expect(mocks.triggerTaskServiceCall).toHaveBeenCalledTimes(1);
    const runFriendlyId = anchoredRunFriendlyIdArg(mocks.triggerTaskServiceCall);
    expect(runFriendlyId).toBeDefined();
    expect(classifyKind(runFriendlyId!)).toBe("runOpsId");
  });

  // The cuid direction catches a "always mint run-ops id regardless of anchor" bug.
  it("happy path: a cuid (LEGACY) batch anchor mints a cuid item", async () => {
    const batchFriendlyId = BatchId.generate().friendlyId; // cuid → LEGACY
    expect(ownerEngine(batchFriendlyId)).toBe("LEGACY");

    mocks.triggerTaskServiceCall.mockResolvedValue({
      run: { id: "run_internal_1", friendlyId: "run_fake", status: "PENDING" },
      isCached: false,
    });

    await processBatch(batchFriendlyId);

    expect(mocks.triggerTaskServiceCall).toHaveBeenCalledTimes(1);
    const runFriendlyId = anchoredRunFriendlyIdArg(mocks.triggerTaskServiceCall);
    expect(runFriendlyId).toBeDefined();
    expect(classifyKind(runFriendlyId!)).toBe("cuid");
  });

  // The pre-failed run created by TriggerFailedTaskService still carries batchId (→ live
  // TaskRun.batchId FK), so it too must be anchored to the batch's residency, not the per-org flag.
  it("failure branch: a run-ops (NEW) batch anchors the pre-failed run to the batch, not the flag", async () => {
    const batchFriendlyId = BatchId.toFriendlyId(generateRunOpsId());
    expect(ownerEngine(batchFriendlyId)).toBe("NEW");

    mocks.triggerTaskServiceCall.mockResolvedValue(undefined); // item trigger fails
    mocks.triggerFailedTaskCall.mockResolvedValue("run_prefailed_fake");

    await processBatch(batchFriendlyId);

    expect(mocks.triggerFailedTaskCall).toHaveBeenCalledTimes(1);
    const [request] = mocks.triggerFailedTaskCall.mock.calls[0] as [{ runFriendlyId?: string }];
    expect(request.runFriendlyId).toBeDefined();
    expect(classifyKind(request.runFriendlyId!)).toBe("runOpsId");
  });

  it("failure branch: a cuid (LEGACY) batch anchors the pre-failed run to a cuid id", async () => {
    const batchFriendlyId = BatchId.generate().friendlyId; // cuid → LEGACY

    mocks.triggerTaskServiceCall.mockResolvedValue(undefined); // item trigger fails
    mocks.triggerFailedTaskCall.mockResolvedValue("run_prefailed_fake");

    await processBatch(batchFriendlyId);

    expect(mocks.triggerFailedTaskCall).toHaveBeenCalledTimes(1);
    const [request] = mocks.triggerFailedTaskCall.mock.calls[0] as [{ runFriendlyId?: string }];
    expect(request.runFriendlyId).toBeDefined();
    expect(classifyKind(request.runFriendlyId!)).toBe("cuid");
  });
});
