// REGRESSION: the 2-phase batch API (createBatch.server.ts + streamBatchItems.server.ts, wired
// through BatchQueue to setupBatchQueueCallbacks) must anchor each item's mint on the BATCH's own
// friendlyId, like batchTriggerV3.server.ts's mintChildFriendlyId does — not re-resolve the
// per-org mint flag, which can flip between batch creation and this async callback. Covers the
// happy path (both residency directions) and all three pre-failed-run branches: trigger returned
// undefined, pre-marked error item, and a thrown trigger error.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findEnvironmentById: vi.fn(),
  triggerTaskServiceCall: vi.fn(),
  triggerFailedTaskCall: vi.fn(),
  setBatchProcessItemCallback: vi.fn(),
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
  findEnvironmentFromRun: vi.fn(),
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

vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    setBatchProcessItemCallback: mocks.setBatchProcessItemCallback,
    setBatchCompletionCallback: vi.fn(),
    tryCompleteBatch: vi.fn(),
  },
}));

vi.mock("~/v3/runOpsMigration/splitMode.server", () => ({ isSplitEnabled: async () => false }));

import {
  BatchId,
  classifyKind,
  generateRunOpsId,
  ownerEngine,
} from "@trigger.dev/core/v3/isomorphic";
import { setupBatchQueueCallbacks } from "~/v3/runEngineHandlers.server";

vi.setConfig({ testTimeout: 30_000 });

type ProcessItemCallback = (args: {
  batchId: string;
  friendlyId: string;
  itemIndex: number;
  item: Record<string, unknown>;
  meta: Record<string, unknown>;
  attempt: number;
  isFinalAttempt: boolean;
}) => Promise<unknown>;

let processItemCallback: ProcessItemCallback;

beforeAll(() => {
  setupBatchQueueCallbacks();
  processItemCallback = mocks.setBatchProcessItemCallback.mock.calls[0][0] as ProcessItemCallback;
});

beforeEach(() => {
  mocks.findEnvironmentById.mockReset().mockResolvedValue({
    id: "env_1",
    organizationId: "org_1",
    organization: { featureFlags: {} },
  });
  mocks.triggerTaskServiceCall.mockReset();
  mocks.triggerFailedTaskCall.mockReset();
});

async function runItem(
  friendlyId: string,
  isFinalAttempt = false,
  itemOptions: Record<string, unknown> = {}
) {
  await processItemCallback({
    batchId: "batch_internal_1",
    friendlyId,
    itemIndex: 0,
    item: {
      task: "some-task",
      payload: "{}",
      payloadType: "application/json",
      options: itemOptions,
    },
    meta: { environmentId: "env_1" },
    attempt: 1,
    isFinalAttempt,
  });
}

describe("setupBatchQueueCallbacks — batch item residency anchoring", () => {
  // Split is off in this test, so re-resolving the per-org flag would yield cuid — a NEW anchor
  // yielding runOpsId proves the anchor wins over what the flag would say.
  it("happy path: a run-ops (NEW) batch anchor mints a run-ops item", async () => {
    const friendlyId = BatchId.toFriendlyId(generateRunOpsId());
    expect(ownerEngine(friendlyId)).toBe("NEW");
    mocks.triggerTaskServiceCall.mockResolvedValue({
      run: { id: "run_internal_1", friendlyId: "run_fake", status: "PENDING" },
      isCached: false,
    });

    await runItem(friendlyId);

    expect(mocks.triggerTaskServiceCall).toHaveBeenCalledTimes(1);
    const [, , , options] = mocks.triggerTaskServiceCall.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      { runFriendlyId?: string } | undefined,
    ];
    expect(options?.runFriendlyId).toBeDefined();
    expect(classifyKind(options!.runFriendlyId!)).toBe("runOpsId");
  });

  // The cuid direction catches a "always mint run-ops id regardless of anchor" bug.
  it("happy path: a cuid (LEGACY) batch anchor mints a cuid item", async () => {
    const friendlyId = BatchId.generate().friendlyId;
    expect(ownerEngine(friendlyId)).toBe("LEGACY");
    mocks.triggerTaskServiceCall.mockResolvedValue({
      run: { id: "run_internal_1", friendlyId: "run_fake", status: "PENDING" },
      isCached: false,
    });

    await runItem(friendlyId);

    expect(mocks.triggerTaskServiceCall).toHaveBeenCalledTimes(1);
    const [, , , options] = mocks.triggerTaskServiceCall.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      { runFriendlyId?: string } | undefined,
    ];
    expect(options?.runFriendlyId).toBeDefined();
    expect(classifyKind(options!.runFriendlyId!)).toBe("cuid");
  });

  // The pre-failed run (TriggerTaskService returned undefined on the final attempt) carries
  // batchId (→ live TaskRun.batchId FK), so it too must be anchored to the batch's residency.
  it("failure branch: a run-ops (NEW) batch anchors the pre-failed run to the batch, not the flag", async () => {
    const friendlyId = BatchId.toFriendlyId(generateRunOpsId());
    expect(ownerEngine(friendlyId)).toBe("NEW");
    mocks.triggerTaskServiceCall.mockResolvedValue(undefined); // item trigger fails
    mocks.triggerFailedTaskCall.mockResolvedValue("run_prefailed_fake");

    await runItem(friendlyId, true);

    expect(mocks.triggerFailedTaskCall).toHaveBeenCalledTimes(1);
    const [request] = mocks.triggerFailedTaskCall.mock.calls[0] as [{ runFriendlyId?: string }];
    expect(request.runFriendlyId).toBeDefined();
    expect(classifyKind(request.runFriendlyId!)).toBe("runOpsId");
  });

  it("failure branch: a cuid (LEGACY) batch anchors the pre-failed run to a cuid id", async () => {
    const friendlyId = BatchId.generate().friendlyId;
    mocks.triggerTaskServiceCall.mockResolvedValue(undefined); // item trigger fails
    mocks.triggerFailedTaskCall.mockResolvedValue("run_prefailed_fake");

    await runItem(friendlyId, true);

    expect(mocks.triggerFailedTaskCall).toHaveBeenCalledTimes(1);
    const [request] = mocks.triggerFailedTaskCall.mock.calls[0] as [{ runFriendlyId?: string }];
    expect(request.runFriendlyId).toBeDefined();
    expect(classifyKind(request.runFriendlyId!)).toBe("cuid");
  });

  // Pre-marked error items (e.g. oversized payloads) are pre-failed before the trigger runs; that
  // pre-failed run also carries batchId, so it must anchor to the batch too.
  it("pre-marked error branch: a run-ops (NEW) batch anchors the pre-failed run to the batch", async () => {
    const friendlyId = BatchId.toFriendlyId(generateRunOpsId());
    expect(ownerEngine(friendlyId)).toBe("NEW");
    mocks.triggerFailedTaskCall.mockResolvedValue("run_prefailed_fake");

    await runItem(friendlyId, false, {
      __error: "payload too large",
      __errorCode: "PAYLOAD_TOO_LARGE",
    });

    expect(mocks.triggerTaskServiceCall).not.toHaveBeenCalled();
    expect(mocks.triggerFailedTaskCall).toHaveBeenCalledTimes(1);
    const [request] = mocks.triggerFailedTaskCall.mock.calls[0] as [{ runFriendlyId?: string }];
    expect(request.runFriendlyId).toBeDefined();
    expect(classifyKind(request.runFriendlyId!)).toBe("runOpsId");
  });

  // The catch branch (the item trigger throws) creates a pre-failed run on the final attempt; it
  // carries batchId, so it must anchor to the batch too.
  it("catch branch: a run-ops (NEW) batch anchors the pre-failed run when the trigger throws", async () => {
    const friendlyId = BatchId.toFriendlyId(generateRunOpsId());
    expect(ownerEngine(friendlyId)).toBe("NEW");
    mocks.triggerTaskServiceCall.mockRejectedValue(new Error("trigger boom"));
    mocks.triggerFailedTaskCall.mockResolvedValue("run_prefailed_fake");

    await runItem(friendlyId, true);

    expect(mocks.triggerFailedTaskCall).toHaveBeenCalledTimes(1);
    const [request] = mocks.triggerFailedTaskCall.mock.calls[0] as [{ runFriendlyId?: string }];
    expect(request.runFriendlyId).toBeDefined();
    expect(classifyKind(request.runFriendlyId!)).toBe("runOpsId");
  });
});
