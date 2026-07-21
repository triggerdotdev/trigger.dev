import { describe, expect, it, vi } from "vitest";

// Force every reacquire attempt to RESOLVE to a winner (never `claimed`/`timed_out`); the spied
// handleExistingRun keeps reporting that winner as cleared, so the bounded loop advances to exhaustion.
vi.mock("~/v3/mollifier/idempotencyClaim.server", () => ({
  resetResolvedClaim: vi.fn(async () => {}),
  claimOrAwait: vi.fn(async () => ({ kind: "resolved", runId: "run_cleared" })),
}));

import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";

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
});
