// Unit red-green for the checkpoint WAIT_FOR_BATCH replica-lag fix (createCheckpoint.server.ts).
// The service decides whether to suspend a run on `batchRun.resumedAt`; reading it from a lagging
// replica makes a just-resumed batch look unresumed -> it suspends an already-resumed run -> stall.
// The fix threads the primary (`this._prisma`) into `runStore.findBatchTaskRunByFriendlyId`. Here a
// spy runStore records which client the service passed and simulates the lag (only the primary read
// sees the fresh resumedAt): RED = no client -> stale null -> no early return; GREEN = primary -> kept alive.

import { describe, expect, it, vi } from "vitest";

vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("~/v3/marqs/index.server", () => ({
  marqs: { replaceMessage: vi.fn(), cancelHeartbeat: vi.fn() },
}));

import { CreateCheckpointService } from "~/v3/services/createCheckpoint.server";

describe("checkpoint WAIT_FOR_BATCH reads the primary, not a lagging replica", () => {
  it("threads the primary so an already-resumed batch keeps the run alive", async () => {
    // A freezable attempt so control reaches the WAIT_FOR_BATCH arm. This object IS the primary the
    // fix must thread into the batch read.
    const prisma = {
      taskRunAttempt: {
        findFirst: async () => ({
          id: "attempt_1",
          status: "EXECUTING",
          taskRunId: "run_1",
          taskRun: { id: "run_1", status: "EXECUTING", runtimeEnvironmentId: "env_1" },
          backgroundWorker: { id: "bw_1", deployment: { imageReference: "img:1" } },
        }),
      },
    };

    let seenClient: unknown = "NOT_CALLED";
    const runStore = {
      findBatchTaskRunByFriendlyId: async (
        _friendlyId: string,
        _environmentId: string,
        _args: unknown,
        client?: unknown
      ) => {
        seenClient = client;
        // Lagging replica: only a read handed the primary sees the just-committed resumedAt.
        return { resumedAt: client === prisma ? new Date() : null };
      },
    };

    const service = new CreateCheckpointService(prisma as never, {} as never, runStore as never);

    let result: unknown;
    try {
      result = await service.call({
        attemptFriendlyId: "attempt_1",
        reason: { type: "WAIT_FOR_BATCH", batchFriendlyId: "batch_1" },
      } as never);
    } catch {
      // Buggy path falls through the pre-check into checkpoint creation (unstubbed) and throws; the
      // recorded client below is what distinguishes RED from GREEN.
    }

    expect(seenClient).toBe(prisma); // the fix: primary threaded into the batch read
    expect(result).toEqual({ success: false, keepRunAlive: true }); // early-return, run kept alive
  });
});
