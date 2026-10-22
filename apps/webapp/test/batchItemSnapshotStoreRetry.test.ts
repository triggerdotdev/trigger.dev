// A trigger that hits a transient snapshot store outage retries past the regular attempt budget;
// every other trigger error keeps it. Real handler under a real BatchQueue (Redis testcontainer).

import { beforeAll, beforeEach, describe, expect, vi } from "vitest";

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

import type { RedisOptions } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { BatchQueue, type CompleteBatchResult } from "@internal/run-engine";
import {
  SnapshotReadUnavailableError,
  SnapshotStateExpiredError,
  SnapshotWriteUnavailableError,
} from "@internal/run-store";
import { TaskRunErrorCodes } from "@trigger.dev/core/v3";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import { setupBatchQueueCallbacks } from "~/v3/runEngineHandlers.server";

vi.setConfig({ testTimeout: 60_000 });

const MAX_ATTEMPTS = 2;
const INFRASTRUCTURE_MAX_ATTEMPTS = 4;
const PARENT_RUN_ID = "run_parent_internal";

let processItemCallback: Parameters<BatchQueue["onProcessItem"]>[0];

beforeAll(() => {
  setupBatchQueueCallbacks();
  processItemCallback = mocks.setBatchProcessItemCallback.mock.calls[0][0];
});

beforeEach(() => {
  mocks.findEnvironmentById.mockReset().mockResolvedValue({
    id: "env_1",
    organizationId: "org_1",
    organization: { featureFlags: {} },
  });
  mocks.triggerTaskServiceCall.mockReset();
  mocks.triggerFailedTaskCall.mockReset().mockResolvedValue("run_prefailed");
});

function residencyReadFailed() {
  return new SnapshotReadUnavailableError(PARENT_RUN_ID, "residency read failed", {
    kind: "error",
  });
}

async function runOneItem(redisOptions: RedisOptions) {
  const queue = new BatchQueue({
    redis: { ...redisOptions, keyPrefix: "test:" },
    drr: { quantum: 5, maxDeficit: 50 },
    consumerCount: 1,
    consumerIntervalMs: 20,
    startConsumers: true,
    retry: {
      maxAttempts: MAX_ATTEMPTS,
      infrastructureMaxAttempts: INFRASTRUCTURE_MAX_ATTEMPTS,
      minTimeoutInMs: 20,
      maxTimeoutInMs: 100,
      factor: 2,
      randomize: false,
    },
  });

  let completion: CompleteBatchResult | null = null;
  try {
    queue.onProcessItem(processItemCallback);
    queue.onBatchComplete(async (result) => {
      completion = result;
    });

    const batchId = "batch_internal_1";
    await queue.initializeBatch({
      batchId,
      friendlyId: BatchId.generate().friendlyId,
      environmentId: "env_1",
      environmentType: "PRODUCTION",
      organizationId: "org_1",
      projectId: "proj_1",
      runCount: 1,
      parentRunId: PARENT_RUN_ID,
      resumeParentOnCompletion: true,
    });
    await queue.enqueueBatchItem(batchId, "env_1", 0, {
      task: "child-task",
      payload: "{}",
      payloadType: "application/json",
      options: {},
    });

    await vi.waitFor(() => expect(completion).not.toBeNull(), { timeout: 20_000, interval: 50 });
  } finally {
    await queue.close();
  }

  return completion!;
}

describe("batch item trigger: transient snapshot store errors", () => {
  redisTest(
    "a snapshot store outage retries past the regular attempt budget and then triggers",
    async ({ redisOptions }) => {
      mocks.triggerTaskServiceCall
        .mockRejectedValueOnce(residencyReadFailed())
        .mockRejectedValueOnce(residencyReadFailed())
        .mockResolvedValueOnce({ run: { friendlyId: "run_child" }, isCached: false });

      const completion = await runOneItem(redisOptions);

      expect(mocks.triggerTaskServiceCall).toHaveBeenCalledTimes(3);
      expect(mocks.triggerFailedTaskCall).not.toHaveBeenCalled();
      expect(completion.successfulRunCount).toBe(1);
      expect(completion.failedRunCount).toBe(0);
      expect(completion.runIds).toEqual(["run_child"]);
    }
  );

  redisTest(
    "any other trigger error still pre-fails the item on the regular final attempt",
    async ({ redisOptions }) => {
      mocks.triggerTaskServiceCall.mockRejectedValue(new Error("trigger boom"));

      const completion = await runOneItem(redisOptions);

      expect(mocks.triggerTaskServiceCall).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      expect(mocks.triggerFailedTaskCall).toHaveBeenCalledTimes(1);
      const [request] = mocks.triggerFailedTaskCall.mock.calls[0] as [
        { errorMessage: string; errorCode: string },
      ];
      expect(request.errorMessage).toBe("trigger boom");
      expect(request.errorCode).toBe(TaskRunErrorCodes.BATCH_ITEM_COULD_NOT_TRIGGER);
      expect(completion.runIds).toEqual(["run_prefailed"]);
    }
  );

  redisTest(
    "expired snapshot state is permanent, so it keeps the regular attempt budget",
    async ({ redisOptions }) => {
      mocks.triggerTaskServiceCall.mockRejectedValue(new SnapshotStateExpiredError(PARENT_RUN_ID));

      await runOneItem(redisOptions);

      expect(mocks.triggerTaskServiceCall).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      expect(mocks.triggerFailedTaskCall).toHaveBeenCalledTimes(1);
    }
  );

  redisTest(
    "a snapshot write that failed before commit still retries past the regular attempt budget",
    async ({ redisOptions }) => {
      mocks.triggerTaskServiceCall
        .mockRejectedValueOnce(
          new SnapshotWriteUnavailableError(PARENT_RUN_ID, "durable residency unresolved (error)")
        )
        .mockRejectedValueOnce(
          new SnapshotWriteUnavailableError(PARENT_RUN_ID, "durable residency unresolved (error)")
        )
        .mockResolvedValueOnce({ run: { friendlyId: "run_child" }, isCached: false });

      const completion = await runOneItem(redisOptions);

      expect(mocks.triggerTaskServiceCall).toHaveBeenCalledTimes(3);
      expect(mocks.triggerFailedTaskCall).not.toHaveBeenCalled();
      expect(completion.runIds).toEqual(["run_child"]);
    }
  );

  // A finalize-phase write failure happens after the trigger's Postgres transaction committed, so the
  // child run row may already exist. Retrying on the larger budget would trigger it again each time.
  redisTest(
    "a snapshot write that failed after commit keeps the regular attempt budget",
    async ({ redisOptions }) => {
      mocks.triggerTaskServiceCall.mockRejectedValue(
        new SnapshotWriteUnavailableError(PARENT_RUN_ID, "finalize outcome unknown", {
          phase: "finalize",
        })
      );

      const completion = await runOneItem(redisOptions);

      expect(mocks.triggerTaskServiceCall).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      expect(mocks.triggerFailedTaskCall).toHaveBeenCalledTimes(1);
      const [request] = mocks.triggerFailedTaskCall.mock.calls[0] as [
        { errorMessage: string; errorCode: string },
      ];
      expect(request.errorMessage).toBe(
        `snapshot write unavailable for ${PARENT_RUN_ID}: finalize outcome unknown`
      );
      expect(request.errorCode).toBe(TaskRunErrorCodes.BATCH_ITEM_COULD_NOT_TRIGGER);
      expect(completion.runIds).toEqual(["run_prefailed"]);
    }
  );

  redisTest(
    "a snapshot store outage that outlasts its own budget pre-fails the item with a distinct message",
    async ({ redisOptions }) => {
      mocks.triggerTaskServiceCall.mockRejectedValue(residencyReadFailed());

      const completion = await runOneItem(redisOptions);

      expect(mocks.triggerTaskServiceCall).toHaveBeenCalledTimes(INFRASTRUCTURE_MAX_ATTEMPTS);
      expect(mocks.triggerFailedTaskCall).toHaveBeenCalledTimes(1);
      const [request] = mocks.triggerFailedTaskCall.mock.calls[0] as [
        { errorMessage: string; errorCode: string },
      ];
      expect(request.errorMessage).toBe(
        `Snapshot store unavailable after ${INFRASTRUCTURE_MAX_ATTEMPTS} attempts: ` +
          `snapshot read unavailable for ${PARENT_RUN_ID}: residency read failed`
      );
      expect(request.errorCode).toBe(TaskRunErrorCodes.BATCH_ITEM_COULD_NOT_TRIGGER);
      expect(completion.runIds).toEqual(["run_prefailed"]);
    }
  );
});
