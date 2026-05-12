import { describe, expect, it, vi } from "vitest";
import { createRealTripEvaluator } from "~/v3/mollifier/mollifierTripEvaluator.server";
import type { MollifierBuffer } from "@trigger.dev/redis-worker";

function fakeBuffer(result: { tripped: boolean; count: number }): MollifierBuffer {
  return {
    evaluateTrip: vi.fn(async () => result),
  } as unknown as MollifierBuffer;
}

describe("createRealTripEvaluator", () => {
  it("returns divert=false when buffer reports not tripped", async () => {
    const evaluator = createRealTripEvaluator({
      getBuffer: () => fakeBuffer({ tripped: false, count: 42 }),
      options: () => ({ windowMs: 200, threshold: 100, holdMs: 500 }),
    });

    const decision = await evaluator({ envId: "env_a", orgId: "org_1", taskId: "t1" });
    expect(decision).toEqual({ divert: false });
  });

  it("returns divert=true with reason per_env_rate when buffer reports tripped", async () => {
    const evaluator = createRealTripEvaluator({
      getBuffer: () => fakeBuffer({ tripped: true, count: 150 }),
      options: () => ({ windowMs: 200, threshold: 100, holdMs: 500 }),
    });

    const decision = await evaluator({ envId: "env_a", orgId: "org_1", taskId: "t1" });
    expect(decision).toEqual({
      divert: true,
      reason: "per_env_rate",
      count: 150,
      threshold: 100,
      windowMs: 200,
      holdMs: 500,
    });
  });

  it("returns divert=false when getBuffer returns null (fail-open)", async () => {
    const evaluator = createRealTripEvaluator({
      getBuffer: () => null,
      options: () => ({ windowMs: 200, threshold: 100, holdMs: 500 }),
    });

    const decision = await evaluator({ envId: "env_a", orgId: "org_1", taskId: "t1" });
    expect(decision).toEqual({ divert: false });
  });

  it("returns divert=false when buffer throws (fail-open)", async () => {
    const errorBuffer = {
      evaluateTrip: vi.fn(async () => {
        throw new Error("redis unavailable");
      }),
    } as unknown as MollifierBuffer;

    const evaluator = createRealTripEvaluator({
      getBuffer: () => errorBuffer,
      options: () => ({ windowMs: 200, threshold: 100, holdMs: 500 }),
    });

    const decision = await evaluator({ envId: "env_a", orgId: "org_1", taskId: "t1" });
    expect(decision).toEqual({ divert: false });
  });
});
