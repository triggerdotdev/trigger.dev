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
      const buffer = new MollifierBuffer({ redisOptions });
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
      const buffer = new MollifierBuffer({ redisOptions });
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

  redisTest(
    "global mode trips on aggregate load across distinct envs with reason global_rate",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions });
      try {
        // threshold=3 → the 4th trigger trips. Crucially every trigger is a
        // DIFFERENT env, so per-env tripping would never fire (each env count=1).
        const options = { mode: "global", windowMs: 5000, threshold: 3, holdMs: 5000 } as const;
        const evaluator = createRealTripEvaluator({
          getBuffer: () => buffer,
          options: () => options,
        });

        await evaluator({ ...inputs, envId: "g1" });
        await evaluator({ ...inputs, envId: "g2" });
        await evaluator({ ...inputs, envId: "g3" });
        const decision = await evaluator({ ...inputs, envId: "g4" });

        expect(decision.divert).toBe(true);
        if (decision.divert) {
          expect(decision.reason).toBe("global_rate");
          expect(decision.count).toBeGreaterThan(options.threshold);
        }
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "per_env mode does NOT trip on the same load spread across distinct envs",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions });
      try {
        const options = { mode: "per_env", windowMs: 5000, threshold: 3, holdMs: 5000 } as const;
        const evaluator = createRealTripEvaluator({
          getBuffer: () => buffer,
          options: () => options,
        });

        // Four triggers, four distinct envs — every per-env counter stays at 1.
        for (const envId of ["p1", "p2", "p3", "p4"]) {
          const decision = await evaluator({ ...inputs, envId });
          expect(decision.divert).toBe(false);
        }
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "switching to global mid-flight starts the global counter cold (per-env load does not preload it)",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions });
      try {
        let mode: "per_env" | "global" = "per_env";
        const evaluator = createRealTripEvaluator({
          getBuffer: () => buffer,
          options: () => ({ mode, windowMs: 5000, threshold: 2, holdMs: 5000 }),
        });

        // Per-env load on env "s1": the 3rd call trips its per-env counter.
        await evaluator({ ...inputs, envId: "s1" });
        await evaluator({ ...inputs, envId: "s1" });
        const perEnvTrip = await evaluator({ ...inputs, envId: "s1" });
        expect(perEnvTrip.divert).toBe(true);

        // Flip to global. If per-env activity had leaked into the global
        // counter it would already be over threshold; instead the global
        // counter starts at 0, so the first two ticks don't trip and the third
        // does — proving cold start + isolation from the per-env counters.
        mode = "global";
        expect((await evaluator({ ...inputs, envId: "s2" })).divert).toBe(false);
        expect((await evaluator({ ...inputs, envId: "s3" })).divert).toBe(false);
        const globalTrip = await evaluator({ ...inputs, envId: "s4" });

        expect(globalTrip.divert).toBe(true);
        if (globalTrip.divert) {
          expect(globalTrip.reason).toBe("global_rate");
          expect(globalTrip.count).toBe(3);
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
      const buffer = new MollifierBuffer({ redisOptions });
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
