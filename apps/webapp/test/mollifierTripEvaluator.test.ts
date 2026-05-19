import { redisTest } from "@internal/testcontainers";
import { MollifierBuffer } from "@trigger.dev/redis-worker";
import { describe, expect, vi } from "vitest";
import { createRealTripEvaluator } from "~/v3/mollifier/mollifierTripEvaluator.server";

vi.setConfig({ testTimeout: 30_000 });

// Use a real MollifierBuffer backed by a Redis testcontainer — repo policy
// is no mocks for Redis. Per-test envIds keep keys disjoint without explicit
// cleanup. We close() the buffer in a finally to release the client.
const inputs = { envId: "env_a", orgId: "org_1", taskId: "t1" } as const;

describe("createRealTripEvaluator", () => {
  redisTest(
    "returns divert=false when the sliding window stays under threshold",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions, entryTtlSeconds: 600 });
      try {
        const evaluator = createRealTripEvaluator({
          getBuffer: () => buffer,
          options: () => ({ windowMs: 1000, threshold: 100, holdMs: 500 }),
        });

        const decision = await evaluator({ ...inputs, envId: "env_under" });
        expect(decision).toEqual({ divert: false });
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "returns divert=true with reason per_env_rate once the window trips",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions, entryTtlSeconds: 600 });
      try {
        // threshold=2 → the 3rd call within windowMs is the first that trips.
        const options = { windowMs: 5000, threshold: 2, holdMs: 5000 } as const;
        const evaluator = createRealTripEvaluator({
          getBuffer: () => buffer,
          options: () => options,
        });

        const envId = "env_trip";
        await evaluator({ ...inputs, envId });
        await evaluator({ ...inputs, envId });
        const decision = await evaluator({ ...inputs, envId });

        expect(decision.divert).toBe(true);
        if (decision.divert) {
          expect(decision.reason).toBe("per_env_rate");
          expect(decision.threshold).toBe(options.threshold);
          expect(decision.windowMs).toBe(options.windowMs);
          expect(decision.holdMs).toBe(options.holdMs);
          expect(decision.count).toBeGreaterThan(options.threshold);
        }
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest("returns divert=false when getBuffer returns null (fail-open)", async () => {
    const evaluator = createRealTripEvaluator({
      getBuffer: () => null,
      options: () => ({ windowMs: 200, threshold: 100, holdMs: 500 }),
    });

    const decision = await evaluator(inputs);
    expect(decision).toEqual({ divert: false });
  });

  redisTest(
    "returns divert=false when buffer throws (fail-open)",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions, entryTtlSeconds: 600 });
      // Closing the client up front means evaluateTrip will throw on the first
      // Redis command — a real failure mode, not a stub.
      await buffer.close();

      const evaluator = createRealTripEvaluator({
        getBuffer: () => buffer,
        options: () => ({ windowMs: 200, threshold: 100, holdMs: 500 }),
      });

      const decision = await evaluator(inputs);
      expect(decision).toEqual({ divert: false });
    },
  );
});
