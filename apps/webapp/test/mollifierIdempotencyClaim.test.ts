import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import {
  claimOrAwait,
  publishClaim,
  releaseClaim,
} from "~/v3/mollifier/idempotencyClaim.server";
import type {
  IdempotencyClaimResult,
  MollifierBuffer,
} from "@trigger.dev/redis-worker";

type ClaimState = {
  value: string | null;
  // Scripted return sequence for claimIdempotency calls. When set,
  // overrides the default behaviour of returning based on `value`.
  scriptedClaims?: IdempotencyClaimResult[];
};

function makeBuffer(initial: ClaimState = { value: null }): {
  buffer: MollifierBuffer;
  state: ClaimState;
} {
  const state = { ...initial };
  const buffer = {
    claimIdempotency: vi.fn(async (): Promise<IdempotencyClaimResult> => {
      if (state.scriptedClaims && state.scriptedClaims.length > 0) {
        return state.scriptedClaims.shift()!;
      }
      if (state.value === null) {
        state.value = "pending";
        return { kind: "claimed" };
      }
      if (state.value === "pending") return { kind: "pending" };
      return { kind: "resolved", runId: state.value };
    }),
    readClaim: vi.fn(async (): Promise<IdempotencyClaimResult | null> => {
      if (state.value === null) return null;
      if (state.value === "pending") return { kind: "pending" };
      return { kind: "resolved", runId: state.value };
    }),
    publishClaim: vi.fn(async ({ runId }: { runId: string }) => {
      state.value = runId;
    }),
    releaseClaim: vi.fn(async () => {
      state.value = null;
    }),
  } as unknown as MollifierBuffer;
  return { buffer, state };
}

const baseInput = {
  envId: "env_a",
  taskIdentifier: "my-task",
  idempotencyKey: "k-1",
};

describe("claimOrAwait", () => {
  it("returns 'claimed' for the first caller — empty key wins SETNX", async () => {
    const { buffer } = makeBuffer({ value: null });
    const outcome = await claimOrAwait({ ...baseInput, buffer });
    expect(outcome).toEqual({ kind: "claimed" });
  });

  it("returns 'resolved' immediately when the key already holds a runId", async () => {
    const { buffer } = makeBuffer({ value: "run_X" });
    const outcome = await claimOrAwait({ ...baseInput, buffer });
    expect(outcome).toEqual({ kind: "resolved", runId: "run_X" });
  });

  it("polls a pending key, then resolves when the runId is published", async () => {
    const { buffer, state } = makeBuffer({ value: "pending" });
    let nowValue = 0;
    let pollCount = 0;
    const outcome = await claimOrAwait({
      ...baseInput,
      buffer,
      now: () => nowValue,
      sleep: async (ms) => {
        nowValue += ms;
        pollCount += 1;
        if (pollCount === 3) state.value = "run_X";
      },
      safetyNetMs: 1000,
      pollStepMs: 25,
    });
    expect(outcome).toEqual({ kind: "resolved", runId: "run_X" });
  });

  it("returns 'timed_out' when the key stays pending past safetyNetMs", async () => {
    const { buffer } = makeBuffer({ value: "pending" });
    let nowValue = 0;
    const outcome = await claimOrAwait({
      ...baseInput,
      buffer,
      now: () => nowValue,
      sleep: async (ms) => {
        nowValue += ms;
      },
      safetyNetMs: 50,
      pollStepMs: 25,
    });
    expect(outcome).toEqual({ kind: "timed_out" });
  });

  it("retries the claim when a polled key vanishes (claimant released)", async () => {
    const { buffer, state } = makeBuffer({ value: "pending" });
    let nowValue = 0;
    let pollCount = 0;
    // Scripted retry: on the second `claimIdempotency` call we win.
    state.scriptedClaims = [
      { kind: "pending" }, // first call (initial)
      { kind: "claimed" }, // second call (retry after release)
    ];
    const outcome = await claimOrAwait({
      ...baseInput,
      buffer,
      now: () => nowValue,
      sleep: async (ms) => {
        nowValue += ms;
        pollCount += 1;
        // First poll cycle: key vanishes (release).
        if (pollCount === 1) state.value = null;
      },
      safetyNetMs: 1000,
      pollStepMs: 25,
    });
    expect(outcome).toEqual({ kind: "claimed" });
  });

  it("fails open with 'claimed' when buffer is null (mollifier disabled)", async () => {
    const outcome = await claimOrAwait({ ...baseInput, buffer: null });
    expect(outcome).toEqual({ kind: "claimed" });
  });

  it("fails open with 'claimed' if buffer.claimIdempotency throws (Redis down)", async () => {
    const buffer = {
      claimIdempotency: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    } as unknown as MollifierBuffer;
    const outcome = await claimOrAwait({ ...baseInput, buffer });
    expect(outcome).toEqual({ kind: "claimed" });
  });

  it("respects an aborted signal during the wait loop", async () => {
    const { buffer } = makeBuffer({ value: "pending" });
    const controller = new AbortController();
    let nowValue = 0;
    let pollCount = 0;
    const outcome = await claimOrAwait({
      ...baseInput,
      buffer,
      now: () => nowValue,
      sleep: async (ms) => {
        nowValue += ms;
        pollCount += 1;
        if (pollCount === 1) controller.abort();
      },
      abortSignal: controller.signal,
      safetyNetMs: 5000,
      pollStepMs: 25,
    });
    expect(outcome).toEqual({ kind: "timed_out" });
  });
});

describe("publishClaim", () => {
  it("writes the runId to the claim key", async () => {
    const { buffer, state } = makeBuffer({ value: "pending" });
    await publishClaim({ ...baseInput, runId: "run_X", buffer });
    expect(state.value).toBe("run_X");
    expect(buffer.publishClaim).toHaveBeenCalledOnce();
  });

  it("no-op when buffer is null", async () => {
    await expect(
      publishClaim({ ...baseInput, runId: "run_X", buffer: null }),
    ).resolves.toBeUndefined();
  });

  it("swallows errors so trigger pipeline isn't broken by Redis hiccups", async () => {
    const buffer = {
      publishClaim: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    } as unknown as MollifierBuffer;
    await expect(
      publishClaim({ ...baseInput, runId: "run_X", buffer }),
    ).resolves.toBeUndefined();
  });
});

describe("releaseClaim", () => {
  it("DELs the claim so waiters can re-acquire", async () => {
    const { buffer, state } = makeBuffer({ value: "pending" });
    await releaseClaim({ ...baseInput, buffer });
    expect(state.value).toBeNull();
  });

  it("no-op when buffer is null", async () => {
    await expect(releaseClaim({ ...baseInput, buffer: null })).resolves.toBeUndefined();
  });
});
