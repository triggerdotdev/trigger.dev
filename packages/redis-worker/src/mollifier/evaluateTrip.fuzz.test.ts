// TEMPORARY: fuzz tests for Phase 1 validation of `MollifierBuffer.evaluateTrip`.
//
// Gated behind `FUZZ=1` so they don't run in CI. Invoke locally with
// `FUZZ=1 pnpm --filter @trigger.dev/redis-worker test src/mollifier/evaluateTrip.fuzz`
// during the live-monitoring window before Phase 2.
//
// Targets: concurrent INCR atomicity, env isolation under high concurrency,
// trip/hold-down semantics under random arrival timing. Seeded via SEED.
// Remove once the trip-evaluator surface is stable across two release cycles.

import { redisTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { Logger } from "@trigger.dev/core/logger";
import { MollifierBuffer } from "./buffer.js";

const FUZZ_ENABLED = process.env.FUZZ === "1";
const maybeDescribe = FUZZ_ENABLED ? describe : describe.skip;

function makeRng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  // items is non-empty by precondition; non-null assertion silences the
  // noUncheckedIndexedAccess rule without runtime cost.
  return item as T;
}

maybeDescribe("MollifierBuffer.evaluateTrip fuzz", () => {
  const seed = process.env.SEED ? Number(process.env.SEED) : Date.now() & 0xffff;
  // eslint-disable-next-line no-console
  console.log(`[fuzz] evaluateTrip seed=${seed}`);

  redisTest(
    `concurrent INCR across N envs preserves atomicity + isolation (seed=${seed})`,
    { timeout: 60_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        entryTtlSeconds: 600,
        logger: new Logger("fuzz", "warn"),
      });

      try {
        const rng = makeRng(seed);
        const envIds = ["e0", "e1", "e2", "e3", "e4"];
        // High threshold so we test pure count integrity, not trip semantics.
        const opts = { windowMs: 5000, threshold: 1_000_000, holdMs: 100 };

        const callsPerEnv = new Map<string, number>();
        for (const e of envIds) callsPerEnv.set(e, 0);

        // Build a random concurrent workload: 500 calls distributed across envs.
        const work = Array.from({ length: 500 }, () => {
          const env = pick(rng, envIds);
          callsPerEnv.set(env, (callsPerEnv.get(env) ?? 0) + 1);
          return env;
        });

        const results = await Promise.all(
          work.map(async (env) => ({ env, result: await buffer.evaluateTrip(env, opts) })),
        );

        // Atomicity: per-env counts returned must form a contiguous 1..N sequence.
        for (const env of envIds) {
          const observed = results
            .filter((r) => r.env === env)
            .map((r) => r.result.count)
            .sort((a, b) => a - b);
          const expected = Array.from({ length: callsPerEnv.get(env) ?? 0 }, (_, i) => i + 1);
          expect(observed, `env ${env}`).toEqual(expected);
        }

        // Isolation: no env's final count touches another's. (Implicit from
        // the above, but assert explicitly: counts per env match issue count.)
        for (const env of envIds) {
          const final = await buffer["redis"].get(`mollifier:rate:${env}`);
          expect(Number(final)).toBe(callsPerEnv.get(env));
        }
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    `random arrivals near window/hold boundaries (seed=${seed}) preserve trip semantics`,
    { timeout: 60_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        entryTtlSeconds: 600,
        logger: new Logger("fuzz", "warn"),
      });

      try {
        const rng = makeRng(seed ^ 0x9e3779b1);
        // Short window + threshold + holdMs to push timing edges fast.
        const opts = { windowMs: 80, threshold: 3, holdMs: 150 };
        const envId = "fuzz_env";

        // Generate 60 random delays in [0, windowMs*1.2). Track the last time
        // the Lua placed/refreshed the PSETEX marker (every call where
        // count > threshold). Slack accounts for Lua-to-JS round-trip plus
        // PSETEX millisecond granularity.
        const calls = 60;
        // Slack absorbs (a) PSETEX millisecond granularity, (b) Lua-to-JS
        // round-trip on a loaded testcontainer (~5-50ms under load),
        // (c) Date.now() vs Redis internal clock skew. holdMs=150ms so 100ms
        // slack is generous without making the invariant tautological.
        const SLACK_MS = 100;
        let lastOverThresholdAt = -Infinity;

        for (let i = 0; i < calls; i++) {
          const delayMs = Math.floor(rng() * Math.floor(opts.windowMs * 1.2));
          await new Promise((r) => setTimeout(r, delayMs));
          const { tripped, count } = await buffer.evaluateTrip(envId, opts);
          const now = Date.now();

          const overThreshold = count > opts.threshold;

          // Invariant A: if count > threshold this call, the Lua just PSETEX'd
          // the marker, so EXISTS must observe it — tripped MUST be true.
          if (overThreshold) {
            expect(tripped, `i=${i}: over-threshold call must see tripped:true`).toBe(true);
          }

          // Invariant B: if tripped:true but count <= threshold, the marker
          // is carryover from a prior over-threshold INCR. That INCR must
          // have happened within holdMs (+ slack for measurement noise).
          if (tripped && !overThreshold) {
            expect(
              now - lastOverThresholdAt,
              `i=${i}: tripped without over-threshold means marker must be recent`,
            ).toBeLessThanOrEqual(opts.holdMs + SLACK_MS);
          }

          if (overThreshold) lastOverThresholdAt = now;
        }

        // Invariant C: after generous idle (> windowMs + holdMs + slack),
        // the env resets to a fresh count of 1, tripped:false.
        await new Promise((r) => setTimeout(r, opts.windowMs + opts.holdMs + 100));
        const reset = await buffer.evaluateTrip(envId, opts);
        expect(reset).toEqual({ tripped: false, count: 1 });
      } finally {
        await buffer.close();
      }
    },
  );
});
