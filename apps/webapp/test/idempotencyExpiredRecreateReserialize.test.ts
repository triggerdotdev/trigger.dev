import { describe, expect, it, vi } from "vitest";

// Devin #2: a global-scope (or scope-absent) key whose existing run is EXPIRED/FAILED gets its key
// cleared and recreated. Under the run-ops split that recreate must serialise through the claim (same
// cross-DB dup risk as the claim-loser cleared path) rather than fall through to an unserialised create.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
  runOpsNewReplica: {},
  runOpsLegacyReplica: {},
}));

const h = vi.hoisted(() => ({ existingRun: null as unknown, splitEnabled: true }));

vi.mock("~/v3/runStore.server", () => ({
  runStore: { findRun: vi.fn(async () => h.existingRun) },
}));
vi.mock("~/v3/mollifier/mollifierBuffer.server", () => ({ getMollifierBuffer: () => null }));
vi.mock("~/v3/mollifier/mollifierGate.server", () => ({
  makeResolveMollifierFlag: () => async () => false,
}));
vi.mock("~/v3/runOpsMigration/splitMode.server", () => ({
  isSplitEnabled: async () => h.splitEnabled,
}));
vi.mock("~/runEngine/concerns/idempotencyResidency.server", () => ({
  resolveIdempotencyDedupClient: async () => ({}),
}));

import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import type { TriggerTaskRequest } from "~/runEngine/types";

function makeRequest(): TriggerTaskRequest {
  return {
    taskId: "my-task",
    environment: { id: "env_a", organizationId: "org_1", organization: { featureFlags: {} } },
    options: {},
    body: { options: { idempotencyKey: "k-1" } }, // scope absent → treated as global
  } as unknown as TriggerTaskRequest;
}

// handleExistingRun's documented contract for an expired/failed run: clear the key, return isCached:false.
const CLEARED = {
  isCached: false as const,
  idempotencyKey: "k-1",
  idempotencyKeyExpiresAt: new Date(Date.now() + 60_000),
};

describe("IdempotencyKeyConcern · expired/failed recreate re-serialisation", () => {
  it("routes the cleared recreate through the claim under global-scope split (no unserialised create)", async () => {
    h.existingRun = { id: "run_internal", friendlyId: "run_friendly" };
    h.splitEnabled = true;
    const concern = new IdempotencyKeyConcern({} as never, {} as never, {} as never);
    vi.spyOn(
      concern as never as { handleExistingRun: () => unknown },
      "handleExistingRun"
    ).mockResolvedValue(CLEARED);
    const SENTINEL = { ...CLEARED, claim: { token: "t" } };
    const reacquire = vi
      .spyOn(
        concern as never as { reacquireClearedGlobalWinner: () => unknown },
        "reacquireClearedGlobalWinner"
      )
      .mockResolvedValue(SENTINEL);

    const result = await concern.handleTriggerRequest(makeRequest(), undefined);

    expect(reacquire).toHaveBeenCalledOnce();
    expect(result).toBe(SENTINEL);
  });

  it("does NOT re-serialise when the split is off — plain recreate", async () => {
    h.existingRun = { id: "run_internal", friendlyId: "run_friendly" };
    h.splitEnabled = false;
    const concern = new IdempotencyKeyConcern({} as never, {} as never, {} as never);
    vi.spyOn(
      concern as never as { handleExistingRun: () => unknown },
      "handleExistingRun"
    ).mockResolvedValue(CLEARED);
    const reacquire = vi
      .spyOn(
        concern as never as { reacquireClearedGlobalWinner: () => unknown },
        "reacquireClearedGlobalWinner"
      )
      .mockResolvedValue({} as never);

    const result = await concern.handleTriggerRequest(makeRequest(), undefined);

    expect(reacquire).not.toHaveBeenCalled();
    expect(result).toBe(CLEARED);
  });
});
