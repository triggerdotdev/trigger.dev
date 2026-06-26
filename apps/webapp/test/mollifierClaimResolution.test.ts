import { describe, expect, it, vi } from "vitest";

// Stub `~/db.server` before importing the concern — the real module
// eagerly calls `prisma.$connect()` at singleton construction, which
// would fail without a database. The concern under test receives its
// prisma via the constructor, so the stub is never used by the code path.
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

// The IdempotencyKeyConcern resolves the pre-gate claim through the
// global mollifier buffer (`getMollifierBuffer`), shared by both
// `claimOrAwait` and `findBufferedRunWithIdempotency`. Control it via a
// hoisted handle so each test can script the claim/lookup responses.
const h = vi.hoisted(() => ({ buffer: null as unknown, orgFlag: true }));
vi.mock("~/v3/mollifier/mollifierBuffer.server", () => ({
  getMollifierBuffer: () => h.buffer,
}));
// Stub `mollifierGate.server` so loading the concern doesn't drag in
// `env.server` (which fails to parse without a populated environment in
// CI). The concern only uses `makeResolveMollifierFlag` to gate the
// claim; tests flip `h.orgFlag` to cover both opted-in and opted-out
// orgs without touching real env or feature-flag wiring.
vi.mock("~/v3/mollifier/mollifierGate.server", () => ({
  makeResolveMollifierFlag: () => async () => h.orgFlag,
}));

import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import type { TriggerTaskRequest } from "~/runEngine/types";

function makeConcern(prisma: { findFirst: () => Promise<unknown> }) {
  return new IdempotencyKeyConcern(
    { taskRun: { findFirst: prisma.findFirst } } as never,
    {} as never, // engine — unused on this path
    {} as never // traceEventConcern — unused on this path
  );
}

function makeRequest(): TriggerTaskRequest {
  return {
    taskId: "my-task",
    environment: {
      id: "env_a",
      organizationId: "org_1",
      // The pre-gate claim is gated by the per-org mollifier flag
      // (mirroring evaluateGate's gating) so non-opted-in orgs don't pay
      // the Redis SETNX. Tests covering the claim path must opt this
      // fake org in, otherwise the concern skips claimOrAwait entirely
      // and the resolution branches under test never run.
      organization: { featureFlags: { mollifierEnabled: true } },
    },
    options: {},
    body: { options: { idempotencyKey: "k-1" } },
  } as unknown as TriggerTaskRequest;
}

describe("IdempotencyKeyConcern · claim resolution", () => {
  it("resolved-but-unfindable falls through to a fresh trigger (no cached run, no claim held)", async () => {
    // The claim slot holds a runId that is gone from both stores: the PG
    // findFirst misses and the buffer lookup misses. Regression guard for
    // the resolved-but-unfindable terminal case — the concern must fall
    // through to a fresh trigger rather than throw, hand back a bogus
    // cached run, or claim ownership it doesn't hold.
    const lookupIdempotency = vi.fn(async () => null);
    h.buffer = {
      claimIdempotency: vi.fn(async () => ({ kind: "resolved", runId: "run_gone" })),
      lookupIdempotency,
    } as unknown as MollifierBuffer;

    const findFirst = vi.fn(async () => null); // PG misses on every call
    const concern = makeConcern({ findFirst });

    const result = await concern.handleTriggerRequest(makeRequest(), undefined);

    expect(result.isCached).toBe(false);
    if (result.isCached === false) {
      // No claim held — we resolved someone else's (stale) claim, we did
      // not win one. The caller must NOT publish/release on our behalf.
      expect(result.claim).toBeUndefined();
      expect(result.idempotencyKey).toBe("k-1");
    }
    // We attempted the buffer fallback before giving up.
    expect(lookupIdempotency).toHaveBeenCalled();
  });

  it("resolved-and-findable returns the existing run as a cached hit", async () => {
    // Guard the happy resolved path: when the claimed runId IS findable
    // (writer-side PG), the fall-through change must not swallow it.
    h.buffer = {
      claimIdempotency: vi.fn(async () => ({ kind: "resolved", runId: "run_winner" })),
      lookupIdempotency: vi.fn(async () => null),
    } as unknown as MollifierBuffer;

    const winner = { id: "run_winner", friendlyId: "run_winner" };
    // First findFirst (initial existingRun check) misses so we enter the
    // claim path; the second (writer-side re-resolve) finds the winner.
    let calls = 0;
    const findFirst = vi.fn(async () => {
      calls += 1;
      return calls >= 2 ? winner : null;
    });
    const concern = makeConcern({ findFirst });

    const result = await concern.handleTriggerRequest(makeRequest(), undefined);

    expect(result.isCached).toBe(true);
    if (result.isCached === true) {
      expect(result.run).toBe(winner);
    }
  });

  it("non-opted-in org skips claimOrAwait entirely (no buffer round-trip, no claim held)", async () => {
    // Regression guard for the per-org gating that keeps the claim's
    // Redis SETNX off the hot path for orgs that haven't opted into the
    // mollifier — even when `TRIGGER_MOLLIFIER_ENABLED=1` globally and
    // the buffer singleton exists. The concern should NOT touch
    // `claimIdempotency` for these orgs; PG's unique constraint already
    // deduplicates same-key races on the pass-through path.
    h.orgFlag = false;
    const claimIdempotency = vi.fn(async () => ({ kind: "claimed" as const }));
    const lookupIdempotency = vi.fn(async () => null);
    h.buffer = {
      claimIdempotency,
      lookupIdempotency,
    } as unknown as MollifierBuffer;

    const findFirst = vi.fn(async () => null);
    const concern = makeConcern({ findFirst });

    try {
      const result = await concern.handleTriggerRequest(makeRequest(), undefined);
      expect(result.isCached).toBe(false);
      if (result.isCached === false) {
        // No claim returned — the caller must NOT publish/release.
        expect(result.claim).toBeUndefined();
        expect(result.idempotencyKey).toBe("k-1");
      }
      // The headline guarantee: zero Redis claim activity for this org.
      expect(claimIdempotency).not.toHaveBeenCalled();
    } finally {
      h.orgFlag = true; // restore for any later tests in this file
    }
  });
});
