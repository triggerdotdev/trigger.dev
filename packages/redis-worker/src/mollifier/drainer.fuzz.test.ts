// TEMPORARY: fuzz tests for Phase 1 validation of `MollifierDrainer`.
//
// Gated behind `FUZZ=1` so they don't run in CI. Invoke locally with
// `FUZZ=1 pnpm --filter @trigger.dev/redis-worker test src/mollifier/drainer.fuzz`
// during the live-monitoring window before Phase 2.
//
// Targets: drainer must drive every accepted entry to a terminal state
// (acked, FAILED, or TTL-expired) under random handler outcomes and random
// arrival timing across multiple envs. Seeded via SEED.
// Remove once the drainer is stable across two release cycles.

import { redisTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { Logger } from "@trigger.dev/core/logger";
import { MollifierBuffer } from "./buffer.js";
import { MollifierDrainer } from "./drainer.js";
import { serialiseSnapshot } from "./schemas.js";

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

type Outcome = "success" | "retryable" | "non_retryable";

class FuzzHandlerError extends Error {
  constructor(public retryable: boolean) {
    super(retryable ? "retryable" : "non_retryable");
  }
}

maybeDescribe("MollifierDrainer fuzz", () => {
  const seed = process.env.SEED ? Number(process.env.SEED) : Date.now() & 0xffff;
  // eslint-disable-next-line no-console
  console.log(`[fuzz] drainer seed=${seed}`);

  redisTest(
    `random handler outcomes across envs drive every entry to terminal (seed=${seed})`,
    { timeout: 120_000 },
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

      const rng = makeRng(seed);
      const envIds = ["e0", "e1", "e2"];
      const entryCount = 60;
      const maxAttempts = 3;

      // Pre-decide each runId's outcome distribution: 70% success, 15% retry, 15% fail.
      const targetOutcome = new Map<string, Outcome>();
      for (let i = 0; i < entryCount; i++) {
        const r = rng();
        const outcome: Outcome = r < 0.7 ? "success" : r < 0.85 ? "retryable" : "non_retryable";
        targetOutcome.set(`r_${i}`, outcome);
      }

      // Track per-runId handler invocations + peak in-flight (separate from
      // entry attempts so we can cross-check).
      const handlerCalls = new Map<string, number>();
      let inflight = 0;
      let peakInflight = 0;
      const concurrency = 4;

      const handler = vi.fn(async (input: { runId: string; attempts: number }) => {
        inflight++;
        if (inflight > peakInflight) peakInflight = inflight;
        try {
          await new Promise((r) => setTimeout(r, 5 + Math.floor(rng() * 20)));
          handlerCalls.set(input.runId, (handlerCalls.get(input.runId) ?? 0) + 1);
          const outcome = targetOutcome.get(input.runId)!;
          if (outcome === "success") return;
          throw new FuzzHandlerError(outcome === "retryable");
        } finally {
          inflight--;
        }
      });

      const drainer = new MollifierDrainer({
        buffer,
        handler,
        concurrency,
        maxAttempts,
        isRetryable: (err) => err instanceof FuzzHandlerError && err.retryable,
        logger: new Logger("fuzz-drainer", "warn"),
      });

      try {
        // Accept entries in random order across envs.
        const order = Array.from({ length: entryCount }, (_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          const tmp = order[i] as number;
          order[i] = order[j] as number;
          order[j] = tmp;
        }
        for (const i of order) {
          await buffer.accept({
            runId: `r_${i}`,
            envId: envIds[i % envIds.length] as string,
            orgId: "org_1",
            payload: serialiseSnapshot({ i }),
          });
        }

        // Drive runOnce until queues + draining all settle.
        let safety = 200;
        while (safety-- > 0) {
          const before = await buffer.listEnvs();
          if (before.length === 0) {
            // Also confirm no DRAINING entries linger.
            const entryKeys = await buffer["redis"].keys("mollifier:entries:*");
            const drainingStillPresent = (
              await Promise.all(
                entryKeys.map(async (k) => (await buffer["redis"].hget(k, "status")) === "DRAINING"),
              )
            ).some((v) => v);
            if (!drainingStillPresent) break;
          }
          await drainer.runOnce();
        }
        expect(safety).toBeGreaterThan(0);

        // Invariant 1: concurrency cap honoured.
        expect(peakInflight).toBeGreaterThan(1);
        expect(peakInflight).toBeLessThanOrEqual(concurrency);

        // Invariant 2: every entry is in a terminal state.
        for (let i = 0; i < entryCount; i++) {
          const runId = `r_${i}`;
          const stored = await buffer.getEntry(runId);
          const outcome = targetOutcome.get(runId)!;

          if (outcome === "success") {
            // success → acked → deleted
            expect(stored, `expected r_${i} acked`).toBeNull();
            expect(handlerCalls.get(runId)).toBe(1);
          } else if (outcome === "non_retryable") {
            // non-retryable → FAILED on first attempt
            expect(stored, `expected r_${i} present`).not.toBeNull();
            expect(stored!.status, `r_${i} status`).toBe("FAILED");
            expect(handlerCalls.get(runId)).toBe(1);
          } else {
            // retryable → retries until maxAttempts, then FAILED
            expect(stored, `expected r_${i} present`).not.toBeNull();
            expect(stored!.status, `r_${i} status`).toBe("FAILED");
            expect(handlerCalls.get(runId), `r_${i} handler calls`).toBe(maxAttempts);
          }
        }

        // Invariant 3: no entry has attempts > maxAttempts.
        const allEntryKeys = await buffer["redis"].keys("mollifier:entries:*");
        for (const k of allEntryKeys) {
          const attempts = Number(await buffer["redis"].hget(k, "attempts"));
          expect(attempts, `entry ${k} attempts`).toBeLessThanOrEqual(maxAttempts);
        }

        // Invariant 4: no orphan queue references at end.
        for (const env of await buffer.listEnvs()) {
          const queueLen = await buffer["redis"].llen(`mollifier:queue:${env}`);
          expect(queueLen, `env ${env} queue should be empty`).toBe(0);
        }
      } finally {
        await drainer.stop({ timeoutMs: 1000 });
        await buffer.close();
      }
    },
  );
});
