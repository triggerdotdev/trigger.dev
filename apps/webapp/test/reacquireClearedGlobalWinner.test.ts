import { describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ store: undefined as any }));

vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const store = H.store;
        if (!store) throw new Error("test bug: H.store not initialised before the read ran");
        const value = store[prop];
        return typeof value === "function" ? value.bind(store) : value;
      },
    }
  ),
}));

// Force every reacquire attempt to RESOLVE to a winner (never `claimed`/`timed_out`); the spied
// handleExistingRun keeps reporting that winner as cleared, so the bounded loop advances to exhaustion.
vi.mock("~/v3/mollifier/idempotencyClaim.server", () => ({
  resetResolvedClaim: vi.fn(async () => {}),
  claimOrAwait: vi.fn(async () => ({ kind: "resolved", runId: "run_cleared" })),
}));

import { RoutingRunStore, UnknownShardKey, type RunStore } from "@internal/run-store";
import { generateRunOpsIdV2 } from "@trigger.dev/core/v3/isomorphic";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { logger } from "~/services/logger.server";

describe("reacquireClearedGlobalWinner — fail closed on exhaustion", () => {
  it("throws a retryable 503 after exhausting reacquires (never falls through to an unserialised create)", async () => {
    const concern = new IdempotencyKeyConcern({} as never, {} as never, {} as never);
    // Winner is findable but perpetually cleared → each pass advances staleRunId, exhausting the bound.
    vi.spyOn(
      concern as unknown as { resolveWinnerAcrossDbs: () => unknown },
      "resolveWinnerAcrossDbs"
    ).mockResolvedValue({ friendlyId: "run_cleared" });
    vi.spyOn(
      concern as unknown as { handleExistingRun: () => unknown },
      "handleExistingRun"
    ).mockResolvedValue({ isCached: false });

    const request = { environment: { id: "env_1" }, taskId: "task" } as never;
    const ctx = {
      idempotencyKey: "k",
      idempotencyKeyExpiresAt: new Date(Date.now() + 60_000),
      dedupClient: {} as never,
      ttlSeconds: 30,
      clearedRunId: "run_cleared",
      safetyNetMs: 5_000,
      pollStepMs: 25,
    };

    await expect(
      (
        concern as unknown as {
          reacquireClearedGlobalWinner: (...a: unknown[]) => Promise<unknown>;
        }
      ).reacquireClearedGlobalWinner(request, undefined, ctx)
    ).rejects.toMatchObject({ name: "ServiceValidationError", status: 503 });
  });

  // Catches: a claim winner on shard m or z read from some store instead of rejected as unconfigured.
  it("logs and rejects with UnknownShardKey when the winner names an unconfigured shard", async () => {
    const unreachable = new Proxy(
      {},
      {
        get() {
          throw new Error("no sub-store should be reached for an unconfigured shard key");
        },
      }
    ) as RunStore;
    H.store = new RoutingRunStore({ new: unreachable, legacy: unreachable });
    const errorLog = vi.spyOn(logger, "error");
    const concern = new IdempotencyKeyConcern({} as never, {} as never, {} as never);
    const resolveWinner = (
      concern as unknown as {
        resolveWinnerAcrossDbs: (winner: string, environmentId: string) => Promise<unknown>;
      }
    ).resolveWinnerAcrossDbs.bind(concern);

    for (const shardKey of ["m", "z"]) {
      errorLog.mockClear();
      await expect(
        resolveWinner(`run_${generateRunOpsIdV2(shardKey)}`, "env_1")
      ).rejects.toBeInstanceOf(UnknownShardKey);
      expect(errorLog).toHaveBeenCalledWith("idempotency: no client configured for shard key", {
        shardKey,
      });
    }
    errorLog.mockRestore();
  });
});
