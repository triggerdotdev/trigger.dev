import { describe, expect, it, vi } from "vitest";

// Stub `~/db.server` before importing the concern — the real module eagerly
// calls `prisma.$connect()` at singleton construction. The concern under test
// receives its prisma via the constructor, and the one-time-token path below
// reaches the claim before any DB read, so the stub is never exercised.
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

// claimOrAwait resolves its backend through getIdempotencyClaimBuffer; script
// it via a hoisted handle so each test controls the claim outcome.
const h = vi.hoisted(() => ({ buffer: null as unknown, v2: true }));
vi.mock("~/v3/mollifier/mollifierBuffer.server", () => ({
  getMollifierBuffer: () => h.buffer,
  getIdempotencyClaimBuffer: () => h.buffer,
}));
// v2 routing is gated on native realtime (deployment env switch + per-org
// `realtimeBackend` flag); that gate is covered by runTableV2.test.ts. Here we
// mock it so each test controls whether the org is cut over to v2, isolating
// the one-time-token claim logic from the gating mechanism.
vi.mock("~/v3/runTableV2.server", () => ({
  shouldUseV2RunTable: () => h.v2,
}));
// The one-time-token claim runs BEFORE the mollifier-flag resolve, but the
// concern still imports the gate module; stub it so loading doesn't pull in
// extra feature-flag wiring.
vi.mock("~/v3/mollifier/mollifierGate.server", () => ({
  makeResolveMollifierFlag: () => async () => false,
}));

import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import type { TriggerTaskRequest } from "~/runEngine/types";

function makeConcern() {
  return new IdempotencyKeyConcern(
    {
      taskRun: { findFirst: async () => null },
      taskRunV2: { findFirst: async () => null },
    } as never,
    {} as never, // engine — unused on this path
    {} as never // traceEventConcern — unused on this path
  );
}

function makeOtuRequest(
  overrides: {
    featureFlags?: Record<string, unknown>;
    oneTimeUseToken?: string | undefined;
    resumeParentOnCompletion?: boolean;
  } = {}
): TriggerTaskRequest {
  return {
    taskId: "my-task",
    environment: {
      id: "env_a",
      organizationId: "org_1",
      organization: { featureFlags: overrides.featureFlags ?? { runTableV2: true } },
    },
    // No idempotencyKey on purpose — this is the path the per-table
    // oneTimeUseToken unique constraint cannot cover across two tables.
    options: { oneTimeUseToken: "oneTimeUseToken" in overrides ? overrides.oneTimeUseToken : "tok-1" },
    body: {
      options: overrides.resumeParentOnCompletion ? { resumeParentOnCompletion: true } : {},
    },
  } as unknown as TriggerTaskRequest;
}

describe("IdempotencyKeyConcern · one-time-use token cross-table claim", () => {
  it("v2 org: a one-time token with no idempotency key takes a claim keyed on the token", async () => {
    const claimIdempotency = vi.fn(async () => ({ kind: "claimed" as const }));
    h.buffer = {
      claimIdempotency,
      readClaim: vi.fn(async () => null),
    } as unknown as MollifierBuffer;

    const result = await makeConcern().handleTriggerRequest(makeOtuRequest(), undefined);

    expect(result.isCached).toBe(false);
    if (result.isCached === false) {
      // The trigger pipeline must publish/release this claim. It is keyed on
      // the namespaced token AND a reserved, task-independent slot — matching
      // the task-independent oneTimeUseToken DB constraint, NOT request.taskId.
      expect(result.claim?.idempotencyKey).toBe("otu:tok-1");
      expect(result.claim?.envId).toBe("env_a");
      expect(result.claim?.taskIdentifier).toBe("__one_time_use_token__");
    }
    expect(claimIdempotency).toHaveBeenCalledTimes(1);
    expect(claimIdempotency.mock.calls[0][0]).toMatchObject({
      idempotencyKey: "otu:tok-1",
      taskIdentifier: "__one_time_use_token__",
    });
  });

  it("v2 org: a concurrent winner (claim resolved) rejects the second presentation as already-used", async () => {
    // The winner committed a run under the token; the loser must be rejected
    // exactly like the within-table P2002 path, NOT allowed to mint a duplicate
    // into the other table.
    h.buffer = {
      claimIdempotency: vi.fn(async () => ({ kind: "resolved", runId: "run_winner" })),
      readClaim: vi.fn(async () => null),
    } as unknown as MollifierBuffer;

    await expect(
      makeConcern().handleTriggerRequest(makeOtuRequest(), undefined)
    ).rejects.toThrow(/already been used/i);
  });

  it("org not cut over to v2: skips the token claim entirely (no Redis round-trip)", async () => {
    h.v2 = false;
    const claimIdempotency = vi.fn(async () => ({ kind: "claimed" as const }));
    h.buffer = {
      claimIdempotency,
      readClaim: vi.fn(async () => null),
    } as unknown as MollifierBuffer;

    try {
      const result = await makeConcern().handleTriggerRequest(makeOtuRequest(), undefined);
      expect(result.isCached).toBe(false);
      if (result.isCached === false) {
        expect(result.claim).toBeUndefined();
      }
      expect(claimIdempotency).not.toHaveBeenCalled();
    } finally {
      h.v2 = true; // restore for the other tests in this file
    }
  });

  it("triggerAndWait one-time token IS claimed (v2 orgs serialise it like the keyed claim)", async () => {
    const claimIdempotency = vi.fn(async () => ({ kind: "claimed" as const }));
    h.buffer = {
      claimIdempotency,
      readClaim: vi.fn(async () => null),
    } as unknown as MollifierBuffer;

    const result = await makeConcern().handleTriggerRequest(
      makeOtuRequest({ resumeParentOnCompletion: true }),
      undefined
    );

    expect(result.isCached).toBe(false);
    if (result.isCached === false) {
      // resumeParentOnCompletion is NOT excluded from the token claim: for a v2
      // org the cross-table dup hole is identical, and the loser is rejected
      // (no cached-run waitpoint subtlety to avoid).
      expect(result.claim?.idempotencyKey).toBe("otu:tok-1");
    }
    expect(claimIdempotency).toHaveBeenCalledTimes(1);
  });

  it("no one-time token: ordinary no-idempotency-key trigger is unaffected", async () => {
    const claimIdempotency = vi.fn(async () => ({ kind: "claimed" as const }));
    h.buffer = {
      claimIdempotency,
      readClaim: vi.fn(async () => null),
    } as unknown as MollifierBuffer;

    const result = await makeConcern().handleTriggerRequest(
      makeOtuRequest({ oneTimeUseToken: undefined }),
      undefined
    );

    expect(result.isCached).toBe(false);
    if (result.isCached === false) {
      expect(result.claim).toBeUndefined();
    }
    expect(claimIdempotency).not.toHaveBeenCalled();
  });
});
