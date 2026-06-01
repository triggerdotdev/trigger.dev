import { redisTest } from "@internal/testcontainers";
import { describe, expect, it } from "vitest";
import { Logger } from "@trigger.dev/core/logger";
import { MollifierBuffer } from "./buffer.js";
import { MollifierDrainer } from "./drainer.js";
import { serialiseSnapshot } from "./schemas.js";

const noopOptions = {
  logger: new Logger("test", "log"),
};

// Module-scope stub helpers used by the unit tests below (no real Redis).
type StubBuffer = Partial<MollifierBuffer> & { [K in keyof MollifierBuffer]?: any };

function makeStubBuffer(overrides: StubBuffer): MollifierBuffer {
  const base: StubBuffer = {
    listOrgs: async () => [],
    listEnvsForOrg: async () => [],
    pop: async () => null,
    ack: async () => {},
    requeue: async () => {},
    fail: async () => true,
    getEntry: async () => null,
    close: async () => {},
  };
  return { ...base, ...overrides } as unknown as MollifierBuffer;
}

// Convenience for tests that don't care about org grouping: treat each
// env as its own org. `listOrgs` returns the env list verbatim;
// `listEnvsForOrg(envId)` returns `[envId]`. Spread into makeStubBuffer
// alongside the test's own `pop` override.
function eachEnvAsOwnOrg(envs: string[]): Partial<StubBuffer> {
  return {
    listOrgs: async () => envs,
    listEnvsForOrg: async (orgId: string) => (envs.includes(orgId) ? [orgId] : []),
  };
}

describe("MollifierDrainer.runOnce", () => {
  redisTest("drains one queued entry through the handler and acks", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      ...noopOptions,
    });

    const handlerCalls: Array<{ runId: string; envId: string; orgId: string; payload: unknown }> =
      [];
    const handler = async (input: {
      runId: string;
      envId: string;
      orgId: string;
      payload: unknown;
    }) => {
      handlerCalls.push(input);
    };
    const drainer = new MollifierDrainer({
      buffer,
      handler,
      concurrency: 5,
      maxAttempts: 3,
      isRetryable: () => false,
      logger: new Logger("test-drainer", "log"),
    });

    try {
      await buffer.accept({
        runId: "run_1",
        envId: "env_a",
        orgId: "org_1",
        payload: serialiseSnapshot({ foo: 1 }),
      });

      const result = await drainer.runOnce();
      expect(result.drained).toBe(1);
      expect(result.failed).toBe(0);
      expect(handlerCalls).toHaveLength(1);
      expect(handlerCalls[0]).toMatchObject({
        runId: "run_1",
        envId: "env_a",
        orgId: "org_1",
        payload: { foo: 1 },
      });

      // After ack the entry persists as a read-fallback safety net with
      // materialised=true and a fresh grace TTL.
      const entry = await buffer.getEntry("run_1");
      expect(entry).not.toBeNull();
      expect(entry!.materialised).toBe(true);
    } finally {
      await buffer.close();
    }
  });

  redisTest("runOnce with no entries does nothing", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      ...noopOptions,
    });

    let handlerCalls = 0;
    const handler = async () => {
      handlerCalls++;
    };
    const drainer = new MollifierDrainer({
      buffer,
      handler,
      concurrency: 5,
      maxAttempts: 3,
      isRetryable: () => false,
      logger: new Logger("test-drainer", "log"),
    });

    try {
      const result = await drainer.runOnce();
      expect(result.drained).toBe(0);
      expect(result.failed).toBe(0);
      expect(handlerCalls).toBe(0);
    } finally {
      await buffer.close();
    }
  });
});

describe("MollifierDrainer.drainBatchSize", () => {
  // Default behaviour (drainBatchSize=1) is exercised by every other
  // test in this file — one pop per env per tick. These tests pin the
  // single-env batched-pop fast path: with drainBatchSize=N, a single
  // env with K buffered entries drains in ceil(K / N) ticks instead of
  // K ticks, capped by the shared `concurrency` for in-flight handlers.

  it("pops up to drainBatchSize entries from a single env in one tick", async () => {
    const queue: string[] = Array.from({ length: 10 }, (_, i) => `run_${i}`);
    const handled: string[] = [];
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(["env_a"]),
      pop: async (envId: string) => {
        if (envId !== "env_a") return null;
        const runId = queue.shift();
        if (!runId) return null;
        return {
          runId,
          envId: "env_a",
          orgId: "org_1",
          payload: "{}",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async (input) => {
        handled.push(input.runId);
      },
      concurrency: 5,
      maxAttempts: 3,
      isRetryable: () => false,
      drainBatchSize: 5,
      logger: new Logger("test-drainer", "log"),
    });

    const r1 = await drainer.runOnce();
    expect(r1.drained).toBe(5);
    expect(handled).toHaveLength(5);

    const r2 = await drainer.runOnce();
    expect(r2.drained).toBe(5);
    expect(handled).toHaveLength(10);

    // Queue now empty — next tick is a no-op.
    const r3 = await drainer.runOnce();
    expect(r3.drained).toBe(0);
    expect(r3.failed).toBe(0);
  });

  it("respects global concurrency cap when batch dispatch exceeds it", async () => {
    // drainBatchSize=10 with concurrency=3 means each tick pops 10
    // entries but only 3 handlers run in parallel; the other 7 sit in
    // pLimit's queue. The cap is on in-flight handlers, not on per-tick
    // pop count.
    const queue: string[] = Array.from({ length: 10 }, (_, i) => `run_${i}`);
    let inflight = 0;
    let peak = 0;
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(["env_a"]),
      pop: async (envId: string) => {
        if (envId !== "env_a") return null;
        const runId = queue.shift();
        if (!runId) return null;
        return {
          runId,
          envId: "env_a",
          orgId: "org_1",
          payload: "{}",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async () => {
        inflight += 1;
        if (inflight > peak) peak = inflight;
        await new Promise((r) => setTimeout(r, 25));
        inflight -= 1;
      },
      concurrency: 3,
      maxAttempts: 3,
      isRetryable: () => false,
      drainBatchSize: 10,
      logger: new Logger("test-drainer", "log"),
    });

    const result = await drainer.runOnce();
    expect(result.drained).toBe(10);
    expect(peak).toBeGreaterThan(1); // genuinely parallel
    expect(peak).toBeLessThanOrEqual(3); // capped
  });

  it("a mid-batch pop failure aborts that env's batch and counts as one failure", async () => {
    // Pin: when the third pop on env_bad throws, the drainer stops
    // popping from that env for this tick (no infinite retry inside one
    // tick), the two entries already popped still get processed, and
    // the env contributes exactly one to the failed count.
    let envBadPops = 0;
    let envGoodPops = 0;
    const handled: string[] = [];
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(["env_bad", "env_good"]),
      pop: async (envId: string) => {
        if (envId === "env_bad") {
          envBadPops += 1;
          if (envBadPops > 2) {
            throw new Error("simulated pop failure mid-batch");
          }
          return {
            runId: `bad_${envBadPops}`,
            envId: "env_bad",
            orgId: "org_bad",
            payload: "{}",
            attempts: 0,
            createdAt: new Date(),
          } as any;
        }
        // env_good — one entry then empty. Track via pop-count rather
        // than handler-side state so the pop loop's synchronous "is the
        // queue empty?" check doesn't race against the parallel handler
        // dispatch that runs after the whole batch is collected.
        envGoodPops += 1;
        if (envGoodPops > 1) return null;
        return {
          runId: "good_1",
          envId: "env_good",
          orgId: "org_good",
          payload: "{}",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async (input) => {
        handled.push(input.runId);
      },
      // Concurrency=1 so the worker pool runs sequentially and pop calls
      // can't race past the `skip.add(envId)` that fires after a pop
      // failure. The semantic this test pins (one env's pop blowup
      // aborts its batch and counts as one failure) is the deterministic
      // case; multi-worker race semantics are exercised by the safety
      // property test below.
      concurrency: 1,
      maxAttempts: 3,
      isRetryable: () => false,
      drainBatchSize: 5,
      logger: new Logger("test-drainer", "log"),
    });

    const result = await drainer.runOnce();
    // env_bad: 2 successful pops processed (drained) + 1 pop failure (failed).
    // env_good: 1 successful pop processed (drained).
    expect(result.drained).toBe(3);
    expect(result.failed).toBe(1);
    expect(new Set(handled)).toEqual(new Set(["bad_1", "bad_2", "good_1"]));
    // We stopped popping env_bad on the failure — no fourth attempt.
    expect(envBadPops).toBe(3);
  });

  it("fans batched pops out across multiple envs in a single tick", async () => {
    // Pin: with N envs each holding K entries and drainBatchSize=K, one
    // tick pops N×K entries and dispatches them all through the shared
    // pLimit. Closes the gap that all the other batch tests cover a
    // single env in isolation.
    const envCount = 10;
    const perEnv = 10;
    const queues = new Map<string, string[]>();
    for (let i = 0; i < envCount; i++) {
      queues.set(
        `env_${i}`,
        Array.from({ length: perEnv }, (_, j) => `env_${i}_run_${j}`),
      );
    }
    const handled: string[] = [];
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg([...queues.keys()]),
      pop: async (envId: string) => {
        const q = queues.get(envId);
        if (!q || q.length === 0) return null;
        const runId = q.shift()!;
        return {
          runId,
          envId,
          orgId: envId,
          payload: "{}",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async (input) => {
        handled.push(input.runId);
      },
      concurrency: 20,
      maxAttempts: 3,
      isRetryable: () => false,
      drainBatchSize: perEnv,
      logger: new Logger("test-drainer", "log"),
    });

    const r = await drainer.runOnce();
    expect(r.drained).toBe(envCount * perEnv);
    expect(handled).toHaveLength(envCount * perEnv);
    // Every env contributed exactly perEnv entries.
    const perEnvCounts = handled.reduce<Record<string, number>>((acc, runId) => {
      const env = runId.replace(/_run_\d+$/, "");
      acc[env] = (acc[env] ?? 0) + 1;
      return acc;
    }, {});
    for (let i = 0; i < envCount; i++) {
      expect(perEnvCounts[`env_${i}`]).toBe(perEnv);
    }
  });

  it("preserves org-level fairness with drainBatchSize > 1", async () => {
    // Regression guard for the hierarchical rotation property at batch
    // > 1: a heavy org with many envs still gets ~1 org-slot per tick,
    // not N. The original test at line ~1066 only exercises batchSize=1;
    // this re-runs the same shape with batchSize=5 to ensure batching
    // doesn't somehow give the noisy tenant more slots.
    const orgAEnvs = Array.from({ length: 6 }, (_, i) => `env_orgA_${i}`);
    const orgBEnv = "env_orgB_only";
    const envOrg = new Map<string, string>();
    for (const e of orgAEnvs) envOrg.set(e, "org_A");
    envOrg.set(orgBEnv, "org_B");
    const queues = new Map<string, Array<{ runId: string; orgId: string }>>();
    for (const e of orgAEnvs) {
      queues.set(
        e,
        Array.from({ length: 100 }, (_, i) => ({
          runId: `${e}_run_${i}`,
          orgId: "org_A",
        })),
      );
    }
    queues.set(
      orgBEnv,
      Array.from({ length: 100 }, (_, i) => ({
        runId: `${orgBEnv}_run_${i}`,
        orgId: "org_B",
      })),
    );

    const drainedByOrg: Record<string, number> = { org_A: 0, org_B: 0 };
    const buffer = makeStubBuffer({
      listOrgs: async () => {
        const orgs = new Set<string>();
        for (const [envId, items] of queues.entries()) {
          if (items.length > 0) orgs.add(envOrg.get(envId)!);
        }
        return [...orgs];
      },
      listEnvsForOrg: async (orgId: string) => {
        const envs: string[] = [];
        for (const [envId, items] of queues.entries()) {
          if (items.length > 0 && envOrg.get(envId) === orgId) envs.push(envId);
        }
        return envs;
      },
      pop: async (envId: string) => {
        const q = queues.get(envId);
        if (!q || q.length === 0) return null;
        const entry = q.shift()!;
        return {
          runId: entry.runId,
          envId,
          orgId: entry.orgId,
          payload: "{}",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async (input) => {
        drainedByOrg[input.orgId] = (drainedByOrg[input.orgId] ?? 0) + 1;
      },
      concurrency: 10,
      maxAttempts: 3,
      isRetryable: () => false,
      maxOrgsPerTick: 100,
      drainBatchSize: 5,
      logger: new Logger("test-drainer", "log"),
    });

    for (let i = 0; i < 20; i++) {
      await drainer.runOnce();
    }

    expect(drainedByOrg["org_A"]).toBeGreaterThan(0);
    expect(drainedByOrg["org_B"]).toBeGreaterThan(0);
    const ratio = drainedByOrg["org_A"]! / drainedByOrg["org_B"]!;
    // Same fairness window as the batchSize=1 sibling test — batching
    // multiplies per-tick throughput uniformly, not asymmetrically.
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.5);
  });

  it("counts mixed handler success and failure within a batched tick correctly", async () => {
    // 5 envs, one entry each, drainBatchSize=5. Three handlers succeed,
    // two throw non-retryable → drained=3, failed=2. Pins that the batched
    // dispatch's drained/failed accounting per entry is preserved when
    // multiple outcomes interleave in one tick.
    const envs = ["env_ok_1", "env_ok_2", "env_ok_3", "env_fail_1", "env_fail_2"];
    const popsByEnv = new Map<string, number>();
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(envs),
      pop: async (envId: string) => {
        if (!envs.includes(envId)) return null;
        // One entry per env then empty. Track via a per-env pop counter
        // so the batch loop terminates after the first hit even though
        // drainBatchSize=5.
        const popped = (popsByEnv.get(envId) ?? 0) + 1;
        popsByEnv.set(envId, popped);
        if (popped > 1) return null;
        return {
          runId: `run_${envId}`,
          envId,
          orgId: envId,
          payload: "{}",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async (input) => {
        if (input.envId.startsWith("env_fail")) {
          throw new Error("simulated handler failure");
        }
      },
      concurrency: 10,
      maxAttempts: 3,
      isRetryable: () => false, // non-retryable → terminal on first attempt
      drainBatchSize: 5,
      logger: new Logger("test-drainer", "log"),
    });

    const r = await drainer.runOnce();
    expect(r.drained).toBe(3);
    expect(r.failed).toBe(2);
  });

  it("never has more than `concurrency` entries popped-but-not-acked at any moment", async () => {
    // Regression guard for the DRAINING blast radius. Each pop+process
    // happens inside a single pLimit slot, so at any instant the number
    // of entries that have been popped (and therefore marked DRAINING in
    // a real buffer) but not yet acked is bounded by `concurrency`. This
    // matters because the stale sweep only catches DRAINING entries
    // visibly after a threshold — a process crash with thousands of
    // mid-flight entries would mean a long detection/recovery window.
    const envCount = 10;
    const perEnv = 20;
    const queues = new Map<string, string[]>();
    for (let i = 0; i < envCount; i++) {
      queues.set(
        `env_${i}`,
        Array.from({ length: perEnv }, (_, j) => `env_${i}_run_${j}`),
      );
    }
    let inflightPoppedNotAcked = 0;
    let peak = 0;
    const concurrency = 4;
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg([...queues.keys()]),
      pop: async (envId: string) => {
        const q = queues.get(envId);
        if (!q || q.length === 0) return null;
        const runId = q.shift()!;
        inflightPoppedNotAcked += 1;
        if (inflightPoppedNotAcked > peak) peak = inflightPoppedNotAcked;
        return {
          runId,
          envId,
          orgId: envId,
          payload: "{}",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
      ack: async () => {
        inflightPoppedNotAcked -= 1;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async () => {
        // Force handler overlap if scheduling allowed it — without a
        // tight per-slot bound the peak would visibly exceed `concurrency`.
        await new Promise((r) => setTimeout(r, 15));
      },
      concurrency,
      maxAttempts: 3,
      isRetryable: () => false,
      drainBatchSize: perEnv,
      logger: new Logger("test-drainer", "log"),
    });

    const r = await drainer.runOnce();
    expect(r.drained).toBe(envCount * perEnv);
    expect(peak).toBeGreaterThan(1); // concurrency is real, not serialised
    expect(peak).toBeLessThanOrEqual(concurrency); // and bounded by it
    expect(inflightPoppedNotAcked).toBe(0); // everything settled
  });

  it("stops popping early when the env's queue empties before reaching drainBatchSize", async () => {
    const queue = ["only_1", "only_2"];
    const handled: string[] = [];
    let popCalls = 0;
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(["env_a"]),
      pop: async (envId: string) => {
        if (envId !== "env_a") return null;
        popCalls += 1;
        const runId = queue.shift();
        if (!runId) return null;
        return {
          runId,
          envId: "env_a",
          orgId: "org_1",
          payload: "{}",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async (input) => {
        handled.push(input.runId);
      },
      // Concurrency=1 isolates the "stop on empty" semantic from the
      // worker pool's parallel-pick race: with multiple workers, several
      // can pick env_a simultaneously and pop in parallel before any of
      // them can `skip.add(envId)`, so the empty-pop count would be
      // >1 nondeterministically.
      concurrency: 1,
      maxAttempts: 3,
      isRetryable: () => false,
      drainBatchSize: 10,
      logger: new Logger("test-drainer", "log"),
    });

    const r = await drainer.runOnce();
    expect(r.drained).toBe(2);
    expect(handled).toEqual(["only_1", "only_2"]);
    // 2 successful pops + 1 sentinel pop that returned null and ended
    // the batch loop — 3 calls, not 10. Bounding stops the Lua spam.
    expect(popCalls).toBe(3);
  });
});

describe("MollifierDrainer error handling", () => {
  redisTest("retryable error requeues and increments attempts", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      ...noopOptions,
    });

    let calls = 0;
    const handler = async () => {
      calls++;
      throw new Error("transient");
    };

    const drainer = new MollifierDrainer({
      buffer,
      handler,
      concurrency: 1,
      maxAttempts: 3,
      isRetryable: () => true,
      logger: new Logger("test-drainer", "log"),
    });

    try {
      await buffer.accept({ runId: "run_r", envId: "env_a", orgId: "org_1", payload: "{}" });

      await drainer.runOnce();
      const after1 = await buffer.getEntry("run_r");
      expect(after1!.status).toBe("QUEUED");
      expect(after1!.attempts).toBe(1);

      await drainer.runOnce();
      const after2 = await buffer.getEntry("run_r");
      expect(after2!.status).toBe("QUEUED");
      expect(after2!.attempts).toBe(2);

      const result3 = await drainer.runOnce();
      // On attempt 3 the drainer hits maxAttempts and calls fail(),
      // which deletes the entry — once the drainer-handler has written
      // the SYSTEM_FAILURE PG row the buffer entry is no longer
      // load-bearing. The runOnce result is the surviving signal.
      const after3 = await buffer.getEntry("run_r");
      expect(after3).toBeNull();
      expect(result3.failed).toBe(1);
      expect(calls).toBe(3);
    } finally {
      await buffer.close();
    }
  });

  redisTest("non-retryable error transitions directly to FAILED", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      ...noopOptions,
    });

    const handler = async () => {
      throw new Error("validation failure");
    };

    const drainer = new MollifierDrainer({
      buffer,
      handler,
      concurrency: 1,
      maxAttempts: 3,
      isRetryable: () => false,
      logger: new Logger("test-drainer", "log"),
    });

    try {
      await buffer.accept({ runId: "run_nr", envId: "env_a", orgId: "org_1", payload: "{}" });

      const result = await drainer.runOnce();

      // fail() deletes the entry once the drainer-handler has written
      // the canonical SYSTEM_FAILURE PG row.
      const entry = await buffer.getEntry("run_nr");
      expect(entry).toBeNull();
      expect(result.failed).toBe(1);
    } finally {
      await buffer.close();
    }
  });

  redisTest(
    "multi-org round-robin: drains one item per org per runOnce",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        ...noopOptions,
      });

      const handled: string[] = [];
      const handler = async (input: { runId: string }) => {
        handled.push(input.runId);
      };

      const drainer = new MollifierDrainer({
        buffer,
        handler,
        concurrency: 10,
        maxAttempts: 3,
        isRetryable: () => false,
        logger: new Logger("test-drainer", "log"),
      });

      try {
        // org_A has two envs (env_a, env_b) → drainer picks one per tick
        // via the per-org env cursor. org_B has one env (env_c) → it's
        // always picked when org_B is in the slice.
        await buffer.accept({ runId: "a1", envId: "env_a", orgId: "org_A", payload: "{}" });
        await buffer.accept({ runId: "b1", envId: "env_b", orgId: "org_A", payload: "{}" });
        await buffer.accept({ runId: "c1", envId: "env_c", orgId: "org_B", payload: "{}" });

        // Tick 1: 2 orgs in slice → 2 pops, one from org_A's rotating env
        // pick and one from org_B's only env.
        const r1 = await drainer.runOnce();
        expect(r1.drained).toBe(2);
        expect(handled).toContain("c1");
        // Org_A contributed exactly one of {a1, b1}.
        const orgADrainedTick1 = handled.filter((h) => h === "a1" || h === "b1");
        expect(orgADrainedTick1).toHaveLength(1);

        handled.length = 0;
        // Tick 2: org_B's queue is empty (only had 1 entry, drained tick 1).
        // listOrgs returns [org_A] only. Drain the remaining org_A env.
        const r2 = await drainer.runOnce();
        expect(r2.drained).toBe(1);
        expect(handled).toHaveLength(1);
        expect(["a1", "b1"]).toContain(handled[0]);
      } finally {
        await buffer.close();
      }
    },
  );
});

// `onTerminalFailure` is the callback the drainer fires on any terminal
// path (non-retryable OR max-attempts-exhausted retryable) before it
// calls `buffer.fail()`. Webapp wires it to `createFailedTaskRun` so the
// customer's run lands a SYSTEM_FAILURE PG row in both cases. Pre-fix,
// the retryable-exhausted path called `buffer.fail()` with no PG row,
// silently losing the run. These tests pin both terminal causes plus the
// retry-on-retryable-callback-failure escape hatch.
describe("MollifierDrainer.onTerminalFailure", () => {
  redisTest(
    "fires with cause max-attempts-exhausted after retryable failures exhaust",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        ...noopOptions,
      });

      let handlerCalls = 0;
      const handler = async () => {
        handlerCalls++;
        throw new Error("retryable PG blip");
      };

      type TerminalCallArgs = {
        runId: string;
        attempts: number;
        cause: "non-retryable" | "max-attempts-exhausted";
        errorMessage: string;
      };
      const terminalCalls: TerminalCallArgs[] = [];

      const drainer = new MollifierDrainer({
        buffer,
        handler,
        onTerminalFailure: async (input) => {
          terminalCalls.push({
            runId: input.runId,
            attempts: input.attempts,
            cause: input.cause,
            errorMessage: input.error.message,
          });
        },
        concurrency: 1,
        maxAttempts: 2,
        isRetryable: () => true,
        logger: new Logger("test-drainer", "log"),
      });

      try {
        await buffer.accept({ runId: "run_exhaust", envId: "env_a", orgId: "org_1", payload: "{}" });

        // Attempt 1: retryable error → requeue, no terminal callback fires.
        const r1 = await drainer.runOnce();
        expect(r1.failed).toBe(1);
        expect(terminalCalls).toHaveLength(0);
        const after1 = await buffer.getEntry("run_exhaust");
        expect(after1!.status).toBe("QUEUED");
        expect(after1!.attempts).toBe(1);

        // Attempt 2: maxAttempts (2) reached → terminal callback fires
        // with cause "max-attempts-exhausted", THEN buffer.fail() deletes.
        const r2 = await drainer.runOnce();
        expect(r2.failed).toBe(1);
        expect(handlerCalls).toBe(2);
        expect(terminalCalls).toHaveLength(1);
        expect(terminalCalls[0]).toMatchObject({
          runId: "run_exhaust",
          attempts: 2,
          cause: "max-attempts-exhausted",
          errorMessage: "retryable PG blip",
        });
        // buffer entry torn down post-callback.
        expect(await buffer.getEntry("run_exhaust")).toBeNull();
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "fires with cause non-retryable on the first non-retryable error",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        ...noopOptions,
      });

      const handler = async () => {
        throw new Error("validation failure");
      };

      const terminalCalls: Array<{ cause: string; attempts: number }> = [];
      const drainer = new MollifierDrainer({
        buffer,
        handler,
        onTerminalFailure: async (input) => {
          terminalCalls.push({ cause: input.cause, attempts: input.attempts });
        },
        concurrency: 1,
        // Generous attempts budget — non-retryable should bypass it
        // entirely and terminate on the first attempt.
        maxAttempts: 5,
        isRetryable: () => false,
        logger: new Logger("test-drainer", "log"),
      });

      try {
        await buffer.accept({ runId: "run_nr", envId: "env_a", orgId: "org_1", payload: "{}" });

        const r = await drainer.runOnce();
        expect(r.failed).toBe(1);
        expect(terminalCalls).toHaveLength(1);
        expect(terminalCalls[0]).toEqual({ cause: "non-retryable", attempts: 1 });
        expect(await buffer.getEntry("run_nr")).toBeNull();
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "callback throwing a retryable error requeues instead of failing",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        ...noopOptions,
      });

      // Handler always fails (non-retryable so we hit onTerminalFailure
      // on the first attempt regardless of maxAttempts).
      const handler = async () => {
        throw new Error("validation failure");
      };

      let callbackInvocations = 0;
      const drainer = new MollifierDrainer({
        buffer,
        handler,
        onTerminalFailure: async () => {
          callbackInvocations++;
          // Simulate PG still unreachable when we try to write the
          // SYSTEM_FAILURE row — drainer should requeue, not fail.
          const err: Error & { code?: string } = new Error("Can't reach database server");
          err.code = "P1001";
          throw err;
        },
        concurrency: 1,
        maxAttempts: 3,
        // Both `validation failure` (handler) AND `P1001` (callback) are
        // retryable from the drainer's perspective. The handler's
        // non-retryable disposition is set by the underlying error
        // identity, not by `isRetryable` — callers like the webapp use a
        // narrower retryable predicate. Here we set `isRetryable: true`
        // because the test only cares about the callback-retryable path.
        isRetryable: () => true,
        logger: new Logger("test-drainer", "log"),
      });

      try {
        await buffer.accept({ runId: "run_cb_retry", envId: "env_a", orgId: "org_1", payload: "{}" });

        // Tick 1: handler throws → attempts=1 < maxAttempts=3 → requeue
        // (no callback invocation, retryable path).
        const r1 = await drainer.runOnce();
        expect(r1.failed).toBe(1);
        expect(callbackInvocations).toBe(0);
        const after1 = await buffer.getEntry("run_cb_retry");
        expect(after1!.status).toBe("QUEUED");
        expect(after1!.attempts).toBe(1);

        // Tick 2: handler throws → attempts=2 < 3 → requeue again.
        const r2 = await drainer.runOnce();
        expect(r2.failed).toBe(1);
        expect(callbackInvocations).toBe(0);

        // Tick 3: handler throws → attempts=3 (the nextAttempts check is
        // `< maxAttempts`, so 3 < 3 is false) → terminal. Callback throws
        // retryable → drainer requeues instead of fail(). Entry survives.
        const r3 = await drainer.runOnce();
        expect(r3.failed).toBe(1);
        expect(callbackInvocations).toBe(1);
        const after3 = await buffer.getEntry("run_cb_retry");
        expect(after3).not.toBeNull();
        expect(after3!.status).toBe("QUEUED");
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "callback throwing a non-retryable error falls through to buffer.fail()",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        ...noopOptions,
      });

      const handler = async () => {
        throw new Error("validation failure");
      };

      const drainer = new MollifierDrainer({
        buffer,
        handler,
        onTerminalFailure: async () => {
          // Genuinely bad write (e.g. snapshot too malformed to insert).
          // Drainer must NOT loop on this — falls through to buffer.fail.
          throw new Error("malformed snapshot");
        },
        concurrency: 1,
        maxAttempts: 3,
        isRetryable: () => false,
        logger: new Logger("test-drainer", "log"),
      });

      try {
        await buffer.accept({ runId: "run_cb_dead", envId: "env_a", orgId: "org_1", payload: "{}" });

        const r = await drainer.runOnce();
        expect(r.failed).toBe(1);
        // Entry was failed despite the callback throwing — the
        // non-retryable branch of the callback-error guard sends it to
        // buffer.fail so a poisoned run can't loop forever.
        expect(await buffer.getEntry("run_cb_dead")).toBeNull();
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "no onTerminalFailure provided keeps pre-fix behaviour (buffer.fail with no callback)",
    { timeout: 20_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        ...noopOptions,
      });

      const handler = async () => {
        throw new Error("validation failure");
      };

      const drainer = new MollifierDrainer({
        buffer,
        handler,
        // onTerminalFailure intentionally omitted — verifies the option
        // is genuinely optional and backwards-compatible.
        concurrency: 1,
        maxAttempts: 2,
        isRetryable: () => false,
        logger: new Logger("test-drainer", "log"),
      });

      try {
        await buffer.accept({ runId: "run_no_cb", envId: "env_a", orgId: "org_1", payload: "{}" });
        const r = await drainer.runOnce();
        expect(r.failed).toBe(1);
        expect(await buffer.getEntry("run_no_cb")).toBeNull();
      } finally {
        await buffer.close();
      }
    },
  );
});

// Transient Redis errors used to permanently kill the loop because
// `processOneFromEnv` didn't catch `buffer.pop()` rejections — the error
// bubbled through `Promise.all` → `runOnce` → `loop`'s outer catch and
// left `isRunning = false`. These tests use a stubbed buffer (no Redis
// container) so we can deterministically inject failures from `listEnvs`
// and `pop` without racing against a real client.
describe("MollifierDrainer resilience to transient buffer errors", () => {
  it("survives a transient listOrgs failure and resumes draining", async () => {
    let listCalls = 0;
    const popped: string[] = [];
    const buffer = makeStubBuffer({
      listOrgs: async () => {
        listCalls += 1;
        if (listCalls === 1) {
          throw new Error("simulated redis blip");
        }
        return ["env_a"];
      },
      listEnvsForOrg: async (orgId: string) => (orgId === "env_a" ? ["env_a"] : []),
      pop: async () => {
        const runId = `run_${popped.length + 1}`;
        if (popped.length >= 2) return null;
        popped.push(runId);
        return {
          runId,
          envId: "env_a",
          orgId: "org_1",
          payload: "{}",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
    });

    const handled: string[] = [];
    const drainer = new MollifierDrainer({
      buffer,
      handler: async (input) => {
        handled.push(input.runId);
      },
      concurrency: 1,
      maxAttempts: 3,
      isRetryable: () => false,
      pollIntervalMs: 20,
      logger: new Logger("test-drainer", "log"),
    });

    drainer.start();
    const deadline = Date.now() + 3_000;
    while (handled.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await drainer.stop({ timeoutMs: 1_000 });

    expect(handled).toEqual(["run_1", "run_2"]);
    expect(listCalls).toBeGreaterThan(1);
  });

  it("a pop failure for one env doesn't poison the rest of the batch", async () => {
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(["bad", "good"]),
      pop: async (envId: string) => {
        if (envId === "bad") {
          throw new Error("simulated pop failure on bad env");
        }
        return {
          runId: "run_good",
          envId: "good",
          orgId: "org_1",
          payload: "{}",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
    });

    const handled: string[] = [];
    const drainer = new MollifierDrainer({
      buffer,
      handler: async (input) => {
        handled.push(input.runId);
      },
      concurrency: 5,
      maxAttempts: 3,
      isRetryable: () => false,
      logger: new Logger("test-drainer", "log"),
    });

    const result = await drainer.runOnce();
    expect(result.drained).toBe(1);
    expect(result.failed).toBe(1);
    expect(handled).toEqual(["run_good"]);
  });

  it("a requeue failure during retry recovery doesn't poison the rest of the batch", async () => {
    // Regression: handler throws a retryable error → processEntry calls
    // buffer.requeue() inside its catch block. If requeue() itself throws
    // (Redis blip during error recovery), the rejection used to escape
    // processOneFromEnv unwrapped and reject the runOnce Promise.all,
    // dropping handler results from sibling envs in the same tick.
    const handled: string[] = [];
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(["bad", "good"]),
      pop: async (envId: string) =>
        ({
          runId: envId === "bad" ? "run_bad" : "run_good",
          envId,
          orgId: "org_1",
          payload: "{}",
          attempts: 0,
          createdAt: new Date(),
        }) as any,
      requeue: async () => {
        throw new Error("simulated requeue failure");
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async (input) => {
        handled.push(input.runId);
        if (input.runId === "run_bad") throw new Error("transient");
      },
      concurrency: 5,
      maxAttempts: 3,
      isRetryable: () => true,
      logger: new Logger("test-drainer", "log"),
    });

    const result = await drainer.runOnce();
    // Two envs scheduled, one handler succeeded (drained), one handler threw
    // and its recovery requeue threw too — counted as failed, batch not poisoned.
    expect(result.drained).toBe(1);
    expect(result.failed).toBe(1);
    expect(new Set(handled)).toEqual(new Set(["run_bad", "run_good"]));
  });

  it("a fail() throw during terminal recovery doesn't poison the rest of the batch", async () => {
    // Regression: handler throws a non-retryable error → processEntry calls
    // buffer.fail() inside its catch block. If fail() itself throws, the
    // rejection used to escape unwrapped and reject runOnce's Promise.all.
    const handled: string[] = [];
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(["bad", "good"]),
      pop: async (envId: string) =>
        ({
          runId: envId === "bad" ? "run_bad" : "run_good",
          envId,
          orgId: "org_1",
          payload: "{}",
          attempts: 0,
          createdAt: new Date(),
        }) as any,
      fail: async () => {
        throw new Error("simulated fail() failure");
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async (input) => {
        handled.push(input.runId);
        if (input.runId === "run_bad") throw new Error("terminal");
      },
      concurrency: 5,
      maxAttempts: 3,
      isRetryable: () => false,
      logger: new Logger("test-drainer", "log"),
    });

    const result = await drainer.runOnce();
    expect(result.drained).toBe(1);
    expect(result.failed).toBe(1);
    expect(new Set(handled)).toEqual(new Set(["run_bad", "run_good"]));
  });
});

describe("MollifierDrainer per-tick org cap", () => {
  // Bounding fan-out prevents one runOnce from queuing thousands of
  // processOneFromEnv jobs when the org set is unexpectedly large.
  // These tests use a stub buffer so we can drive the org/env counts
  // deterministically without provisioning a real Redis with thousands
  // of envs.

  it("processes at most maxOrgsPerTick envs per runOnce", async () => {
    const allEnvs = Array.from({ length: 20 }, (_, i) => `env_${i}`);
    const popped: string[] = [];
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(allEnvs),
      pop: async (envId: string) => {
        popped.push(envId);
        return null; // empty queue — runOnce records this as "empty"
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async () => {},
      concurrency: 5,
      maxAttempts: 3,
      isRetryable: () => false,
      maxOrgsPerTick: 5,
      logger: new Logger("test-drainer", "log"),
    });

    await drainer.runOnce();
    expect(popped).toHaveLength(5);
  });

  it("covers the full env set across `envs.length` ticks when sliced", async () => {
    const allEnvs = Array.from({ length: 12 }, (_, i) => `env_${i}`);
    const popped: string[] = [];
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(allEnvs),
      pop: async (envId: string) => {
        popped.push(envId);
        return null;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async () => {},
      concurrency: 4,
      maxAttempts: 3,
      isRetryable: () => false,
      maxOrgsPerTick: 4,
      logger: new Logger("test-drainer", "log"),
    });

    // Cursor advances by 1 each tick. Over envs.length ticks every env
    // appears in exactly `sliceSize` of them (slices overlap — intentional,
    // see the head-of-line fairness test below).
    for (let i = 0; i < allEnvs.length; i++) {
      await drainer.runOnce();
    }

    expect(new Set(popped)).toEqual(new Set(allEnvs));
    expect(popped).toHaveLength(allEnvs.length * 4); // envs.length × sliceSize
    const perEnvCounts = popped.reduce<Record<string, number>>((acc, e) => {
      acc[e] = (acc[e] ?? 0) + 1;
      return acc;
    }, {});
    for (const env of allEnvs) {
      expect(perEnvCounts[env]).toBe(4);
    }
  });

  it("preserves head-of-line fairness when sliced: every env reaches every slice position", async () => {
    // Regression test for the bias that advance-by-sliceSize would
    // reintroduce. With fixed disjoint slices, env_0 would always be at
    // position 0 (first into pLimit) and env_(sliceSize-1) would always
    // be last. Advance-by-1 spreads each env across every slot.
    const allEnvs = Array.from({ length: 8 }, (_, i) => `env_${i}`);
    const sliceSize = 4;
    const positionsByEnv = new Map<string, Set<number>>();
    for (const env of allEnvs) positionsByEnv.set(env, new Set());

    let currentTick: string[] = [];
    const popOrderBuffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(allEnvs),
      pop: async (envId: string) => {
        currentTick.push(envId);
        return null;
      },
    });

    const drainer = new MollifierDrainer({
      buffer: popOrderBuffer,
      handler: async () => {},
      // Concurrency >= sliceSize so pLimit doesn't reorder — pop call order
      // matches the slice's scheduling order (i.e. the env's slot position).
      concurrency: sliceSize,
      maxAttempts: 3,
      isRetryable: () => false,
      maxOrgsPerTick: sliceSize,
      logger: new Logger("test-drainer", "log"),
    });

    for (let tick = 0; tick < allEnvs.length; tick++) {
      currentTick = [];
      await drainer.runOnce();
      currentTick.forEach((env, position) => {
        positionsByEnv.get(env)!.add(position);
      });
    }

    // Each env should have occupied every slot 0..sliceSize-1 across the
    // cycle. If we'd regressed to advance-by-sliceSize, env_0 would only
    // ever be at position 0 and env_3 only at position 3.
    for (const env of allEnvs) {
      const positions = positionsByEnv.get(env)!;
      expect(positions.size).toBe(sliceSize);
      for (let p = 0; p < sliceSize; p++) {
        expect(positions.has(p)).toBe(true);
      }
    }
  });

  it("takes all envs and rotates by 1 when the set fits within the cap", async () => {
    const allEnvs = ["env_a", "env_b", "env_c"];
    const popsPerTick: string[][] = [];
    let tick: string[] = [];
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(allEnvs),
      pop: async (envId: string) => {
        tick.push(envId);
        return null;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async () => {},
      concurrency: 3,
      maxAttempts: 3,
      isRetryable: () => false,
      maxOrgsPerTick: 100, // way above n
      logger: new Logger("test-drainer", "log"),
    });

    for (let i = 0; i < 3; i++) {
      tick = [];
      await drainer.runOnce();
      popsPerTick.push(tick);
    }

    // Every tick covers every env (because cap > n), but the head-of-line
    // env rotates by 1 each tick — preserves the original fairness behaviour.
    for (const popped of popsPerTick) {
      expect(new Set(popped)).toEqual(new Set(allEnvs));
    }
    const [tick0, tick1, tick2] = popsPerTick;
    expect(tick0?.[0]).not.toEqual(tick1?.[0]);
    expect(tick1?.[0]).not.toEqual(tick2?.[0]);
  });

  it("a light env is not starved behind heavy envs", async () => {
    // The buffer's atomic Lua removes an env from `mollifier:envs` the
    // moment its queue becomes empty, so a heavy env with thousands of
    // pending entries stays in listEnvs and a light env with a single
    // entry only stays until that one entry pops. Combined with the
    // advance-by-1 cursor, this means the light env can't be parked
    // behind heavy envs indefinitely — it gets popped within at most
    // `envs.length - sliceSize + 1` ticks regardless of how many
    // entries the heavy envs have queued.
    const heavy = Array.from({ length: 6 }, (_, i) => `env_heavy_${i}`);
    const light = "env_light";
    const queues = new Map<string, string[]>();
    for (const h of heavy) {
      queues.set(
        h,
        Array.from({ length: 100 }, (_, i) => `${h}_run_${i}`),
      );
    }
    queues.set(light, [`${light}_run_0`]);

    const activeEnvs = () =>
      [...queues.keys()].filter((k) => (queues.get(k)?.length ?? 0) > 0);
    const buffer = makeStubBuffer({
      listOrgs: async () => activeEnvs(),
      listEnvsForOrg: async (orgId: string) =>
        activeEnvs().includes(orgId) ? [orgId] : [],
      pop: async (envId: string) => {
        const q = queues.get(envId);
        if (!q || q.length === 0) return null;
        const runId = q.shift()!;
        return {
          runId,
          envId,
          orgId: "org_1",
          payload: "{}",
          status: "DRAINING",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async () => {},
      concurrency: 4,
      maxAttempts: 3,
      isRetryable: () => false,
      maxOrgsPerTick: 4, // < 7 envs so we exercise slicing
      logger: new Logger("test-drainer", "log"),
    });

    // 7 envs, sliceSize=4 → worst-case wait for env_light is 4 ticks
    // (it appears in the slice in exactly 4 of every 7 ticks). Run 7 to
    // give the upper bound a wide margin.
    const ticksUntilLightDrained = await (async () => {
      for (let tick = 1; tick <= 7; tick++) {
        await drainer.runOnce();
        if ((queues.get(light)?.length ?? 0) === 0) return tick;
      }
      return Infinity;
    })();

    expect(ticksUntilLightDrained).toBeLessThanOrEqual(4);
    // Sanity: heavy envs are being worked on (not starved themselves) but
    // are far from drained — confirms we measured the right property.
    for (const h of heavy) {
      const remaining = queues.get(h)!.length;
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThan(100);
    }
  });

  it("a light org is not starved behind a heavy org with many envs", async () => {
    // Org-level no-starvation: org_B's single entry drains within ~1
    // tick because the drainer walks orgs at the top level. Org_A
    // having many envs doesn't give it extra rotation slots.
    const orgAEnvs = Array.from({ length: 6 }, (_, i) => `env_orgA_${i}`);
    const orgBEnv = "env_orgB_only";
    const envOrg = new Map<string, string>();
    for (const e of orgAEnvs) envOrg.set(e, "org_A");
    envOrg.set(orgBEnv, "org_B");
    const queues = new Map<string, Array<{ runId: string; orgId: string }>>();
    for (const e of orgAEnvs) {
      queues.set(
        e,
        Array.from({ length: 100 }, (_, i) => ({
          runId: `${e}_run_${i}`,
          orgId: "org_A",
        })),
      );
    }
    queues.set(orgBEnv, [{ runId: `${orgBEnv}_run_0`, orgId: "org_B" }]);

    const drainedByOrg: Record<string, number> = { org_A: 0, org_B: 0 };
    const buffer = makeStubBuffer({
      listOrgs: async () => {
        const orgs = new Set<string>();
        for (const [envId, items] of queues.entries()) {
          if (items.length > 0) orgs.add(envOrg.get(envId)!);
        }
        return [...orgs];
      },
      listEnvsForOrg: async (orgId: string) => {
        const envs: string[] = [];
        for (const [envId, items] of queues.entries()) {
          if (items.length > 0 && envOrg.get(envId) === orgId) envs.push(envId);
        }
        return envs;
      },
      pop: async (envId: string) => {
        const q = queues.get(envId);
        if (!q || q.length === 0) return null;
        const entry = q.shift()!;
        return {
          runId: entry.runId,
          envId,
          orgId: entry.orgId,
          payload: "{}",
          status: "DRAINING",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async (input) => {
        drainedByOrg[input.orgId] = (drainedByOrg[input.orgId] ?? 0) + 1;
      },
      concurrency: 4,
      maxAttempts: 3,
      isRetryable: () => false,
      maxOrgsPerTick: 4,
      logger: new Logger("test-drainer", "log"),
    });

    // Only 2 orgs in play → both are in every tick's slice. Org_B's
    // single env is popped on tick 1.
    const ticksUntilOrgBDrained = await (async () => {
      for (let tick = 1; tick <= 7; tick++) {
        await drainer.runOnce();
        if ((drainedByOrg["org_B"] ?? 0) > 0) return tick;
      }
      return Infinity;
    })();

    expect(ticksUntilOrgBDrained).toBe(1);
    // Sanity: org_A is being drained too (not starved itself) but its many
    // envs are far from empty.
    expect(drainedByOrg["org_A"]).toBeGreaterThan(0);
    for (const e of orgAEnvs) {
      expect(queues.get(e)!.length).toBeGreaterThan(0);
    }
  });

  it("a heavy org with many envs gets ~1 slot per tick, not N slots", async () => {
    // Hierarchical rotation property: an org with N envs gets the SAME
    // per-tick scheduling slot as an org with 1 env, instead of N slots
    // (which is what per-env rotation would give). Sustained-run drainage
    // rate is therefore determined by org count, not env count.
    //
    // Org_A: 6 envs × 100 entries (a noisy tenant).
    // Org_B: 1 env × 100 entries (a quiet tenant).
    // Per-env rotation would drain org_A 6× faster than org_B. The org-
    // level walk via listOrgs → listEnvsForOrg drains them at ~1:1 over
    // a sustained window.
    const orgAEnvs = Array.from({ length: 6 }, (_, i) => `env_orgA_${i}`);
    const orgBEnv = "env_orgB_only";
    const envOrg = new Map<string, string>();
    for (const e of orgAEnvs) envOrg.set(e, "org_A");
    envOrg.set(orgBEnv, "org_B");
    const queues = new Map<string, Array<{ runId: string; orgId: string }>>();
    for (const e of orgAEnvs) {
      queues.set(
        e,
        Array.from({ length: 100 }, (_, i) => ({
          runId: `${e}_run_${i}`,
          orgId: "org_A",
        })),
      );
    }
    queues.set(
      orgBEnv,
      Array.from({ length: 100 }, (_, i) => ({
        runId: `${orgBEnv}_run_${i}`,
        orgId: "org_B",
      })),
    );

    const drainedByOrg: Record<string, number> = { org_A: 0, org_B: 0 };
    const buffer = makeStubBuffer({
      listOrgs: async () => {
        const orgs = new Set<string>();
        for (const [envId, items] of queues.entries()) {
          if (items.length > 0) orgs.add(envOrg.get(envId)!);
        }
        return [...orgs];
      },
      listEnvsForOrg: async (orgId: string) => {
        const envs: string[] = [];
        for (const [envId, items] of queues.entries()) {
          if (items.length > 0 && envOrg.get(envId) === orgId) envs.push(envId);
        }
        return envs;
      },
      pop: async (envId: string) => {
        const q = queues.get(envId);
        if (!q || q.length === 0) return null;
        const entry = q.shift()!;
        return {
          runId: entry.runId,
          envId,
          orgId: entry.orgId,
          payload: "{}",
          status: "DRAINING",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async (input) => {
        drainedByOrg[input.orgId] = (drainedByOrg[input.orgId] ?? 0) + 1;
      },
      concurrency: 10,
      maxAttempts: 3,
      isRetryable: () => false,
      maxOrgsPerTick: 100, // unsliced — every org gets a slot every tick
      logger: new Logger("test-drainer", "log"),
    });

    for (let i = 0; i < 20; i++) {
      await drainer.runOnce();
    }

    // Under per-env rotation, drainedByOrg.org_A would be ~6× larger than
    // drainedByOrg.org_B. Under hierarchical, the ratio is ~1.
    expect(drainedByOrg["org_A"]).toBeGreaterThan(0);
    expect(drainedByOrg["org_B"]).toBeGreaterThan(0);
    const ratio = drainedByOrg["org_A"]! / drainedByOrg["org_B"]!;
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.5);
  });

  it("within an org, envs are rotated round-robin across ticks", async () => {
    // An org with N envs picks one env per tick, cycling through its
    // envs via the per-org env cursor. Inner cursor advances by 1 per
    // visit to the org (analogous to head-of-line fairness within a
    // slice, but at the env-within-org layer).
    const orgEnvs = ["env_x", "env_y", "env_z"];
    const orgId = "org_solo";
    const queues = new Map<string, number>();
    for (const e of orgEnvs) queues.set(e, 100);

    const poppedSequence: string[] = [];
    const buffer = makeStubBuffer({
      listOrgs: async () => {
        const anyEnvActive = [...queues.values()].some((n) => n > 0);
        return anyEnvActive ? [orgId] : [];
      },
      listEnvsForOrg: async (org: string) =>
        org === orgId
          ? [...queues.keys()].filter((k) => (queues.get(k) ?? 0) > 0)
          : [],
      pop: async (envId: string) => {
        const remaining = queues.get(envId) ?? 0;
        if (remaining === 0) return null;
        queues.set(envId, remaining - 1);
        poppedSequence.push(envId);
        return {
          runId: `${envId}_${remaining}`,
          envId,
          orgId,
          payload: "{}",
          status: "DRAINING",
          attempts: 0,
          createdAt: new Date(),
        } as any;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async () => {},
      concurrency: 1,
      maxAttempts: 3,
      isRetryable: () => false,
      maxOrgsPerTick: 100,
      logger: new Logger("test-drainer", "log"),
    });

    // 6 ticks × 1 env per tick = 6 pops, cycling x, y, z, x, y, z. Every
    // env should be picked exactly twice across the 6 ticks.
    for (let i = 0; i < 6; i++) {
      await drainer.runOnce();
    }

    expect(poppedSequence).toHaveLength(6);
    const counts = poppedSequence.reduce<Record<string, number>>((acc, e) => {
      acc[e] = (acc[e] ?? 0) + 1;
      return acc;
    }, {});
    for (const env of orgEnvs) {
      expect(counts[env]).toBe(2);
    }
  });
});

describe("MollifierDrainer additional coverage", () => {

  it("a malformed payload is treated as a non-retryable handler error and goes terminal", async () => {
    // The deserialise call lives inside processEntry's try, so a JSON parse
    // failure is caught by the same handler-error branch. With
    // isRetryable=false, the entry transitions directly to FAILED — the
    // handler is never invoked because the throw happens before the
    // handler call.
    let handlerCalled = false;
    const failedEntries: Array<{ runId: string; error: { code: string; message: string } }> = [];
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(["env_a"]),
      pop: async () =>
        ({
          runId: "run_malformed",
          envId: "env_a",
          orgId: "org_1",
          payload: "not valid json {",
          status: "DRAINING",
          attempts: 0,
          createdAt: new Date(),
        }) as any,
      fail: async (runId: string, error: { code: string; message: string }) => {
        failedEntries.push({ runId, error });
        return true;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async () => {
        handlerCalled = true;
      },
      concurrency: 1,
      maxAttempts: 3,
      isRetryable: () => false,
      logger: new Logger("test-drainer", "log"),
    });

    const result = await drainer.runOnce();

    expect(handlerCalled).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.drained).toBe(0);
    expect(failedEntries).toHaveLength(1);
    expect(failedEntries[0]?.runId).toBe("run_malformed");
  });

  it("an ack failure after a successful handler is currently treated as a handler error (documented behaviour)", async () => {
    // CAVEAT: this pins a known behaviour gap, not the ideal behaviour.
    // ack() lives inside the same try as the handler call, so if the
    // handler succeeds but ack throws (e.g. transient Redis blip), the
    // entry is routed through the retry/terminal path even though the
    // handler-side work completed. A later engine-replay handler will
    // need idempotency to absorb the re-execution this implies on retry,
    // OR ack should be lifted out of the try block.
    let handlerCalls = 0;
    const failedEntries: string[] = [];
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(["env_a"]),
      pop: async () =>
        ({
          runId: "run_x",
          envId: "env_a",
          orgId: "org_1",
          payload: "{}",
          status: "DRAINING",
          attempts: 0,
          createdAt: new Date(),
        }) as any,
      ack: async () => {
        throw new Error("simulated ack failure");
      },
      fail: async (runId: string) => {
        failedEntries.push(runId);
        return true;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async () => {
        handlerCalls += 1;
      },
      concurrency: 1,
      maxAttempts: 3,
      isRetryable: () => false,
      logger: new Logger("test-drainer", "log"),
    });

    await drainer.runOnce();

    expect(handlerCalls).toBe(1); // handler did run
    expect(failedEntries).toEqual(["run_x"]); // but entry was marked failed anyway
  });

  it("start() called twice does not spawn a second loop", async () => {
    let listEnvsCalls = 0;
    const buffer = makeStubBuffer({
      listOrgs: async () => {
        listEnvsCalls += 1;
        return [];
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async () => {},
      concurrency: 1,
      maxAttempts: 3,
      isRetryable: () => false,
      pollIntervalMs: 50,
      logger: new Logger("test-drainer", "log"),
    });

    drainer.start();
    drainer.start(); // no-op
    await new Promise((r) => setTimeout(r, 150));
    await drainer.stop({ timeoutMs: 500 });

    // One loop's worth of polling, not two. Allow a small fudge for timing —
    // a doubled loop would produce ~2x the calls in the same window.
    expect(listEnvsCalls).toBeLessThan(10);
  });

  it("stop() is idempotent and safe to call when never started", async () => {
    const buffer = makeStubBuffer({});
    const drainer = new MollifierDrainer({
      buffer,
      handler: async () => {},
      concurrency: 1,
      maxAttempts: 3,
      isRetryable: () => false,
      logger: new Logger("test-drainer", "log"),
    });

    // Never started.
    await expect(drainer.stop()).resolves.toBeUndefined();

    // Started then stopped twice.
    drainer.start();
    await expect(drainer.stop()).resolves.toBeUndefined();
    await expect(drainer.stop()).resolves.toBeUndefined();
  });

  it("rotation cursors reset on start() so a stop+start cycle begins fresh", async () => {
    const allEnvs = ["env_a", "env_b", "env_c", "env_d", "env_e", "env_f"];
    const popLog: string[] = [];
    const buffer = makeStubBuffer({
      ...eachEnvAsOwnOrg(allEnvs),
      pop: async (envId: string) => {
        popLog.push(envId);
        return null;
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async () => {},
      concurrency: 3,
      maxAttempts: 3,
      isRetryable: () => false,
      maxOrgsPerTick: 3,
      // Long sleep so the loop ticks exactly once between start() and stop().
      pollIntervalMs: 10_000,
      logger: new Logger("test-drainer", "log"),
    });

    // Advance the cursor via runOnce so it's nonzero before start().
    await drainer.runOnce();
    await drainer.runOnce();
    popLog.length = 0;

    drainer.start();
    // Wait long enough for the loop's first tick to complete.
    await new Promise((r) => setTimeout(r, 100));
    await drainer.stop({ timeoutMs: 1_000 });

    // The first slice after start() should begin at envs[0] (cursor reset)
    // — the slice is [env_a, env_b, env_c]. Without the reset, it would
    // start at env_c (cursor was 2).
    expect(popLog.slice(0, 3)).toEqual(["env_a", "env_b", "env_c"]);
  });

  it("loop backoff grows with consecutive runOnce failures and resets on success", async () => {
    // The loop catches runOnce-level errors (e.g. listEnvs blip), increments
    // `consecutiveErrors`, and delays for backoffMs(consecutiveErrors) —
    // capped at 5s. This test pins the growth curve by failing N times in a
    // row and observing increasing inter-tick gaps, then succeeding to
    // verify the counter resets.
    const tickTimestamps: number[] = [];
    let listEnvsCalls = 0;
    const buffer = makeStubBuffer({
      listOrgs: async () => {
        listEnvsCalls += 1;
        tickTimestamps.push(Date.now());
        if (listEnvsCalls <= 4) {
          throw new Error("simulated sustained outage");
        }
        return []; // success — resets consecutiveErrors
      },
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler: async () => {},
      concurrency: 1,
      maxAttempts: 3,
      isRetryable: () => false,
      pollIntervalMs: 100,
      logger: new Logger("test-drainer", "log"),
    });

    drainer.start();
    // Allow time for 4 failures + first success + a few subsequent successes.
    // Backoff schedule on errors 1..4: 200ms, 400ms, 800ms, 1.6s ≈ 3s total
    // worst case. Add headroom for jitter.
    await new Promise((r) => setTimeout(r, 4_000));
    await drainer.stop({ timeoutMs: 1_000 });

    expect(listEnvsCalls).toBeGreaterThanOrEqual(5);
    // Inter-tick gaps during the failure run should grow (exponential).
    const gap1 = tickTimestamps[1]! - tickTimestamps[0]!;
    const gap2 = tickTimestamps[2]! - tickTimestamps[1]!;
    const gap3 = tickTimestamps[3]! - tickTimestamps[2]!;
    expect(gap2).toBeGreaterThan(gap1);
    expect(gap3).toBeGreaterThan(gap2);

    // After the first success (tick 5), counter resets, so the gap between
    // tick 5 and tick 6 should drop back to pollIntervalMs-ish — much
    // smaller than gap3 (which was the longest backoff).
    if (tickTimestamps.length >= 6) {
      const postRecoveryGap = tickTimestamps[5]! - tickTimestamps[4]!;
      expect(postRecoveryGap).toBeLessThan(gap3);
    }
  });
});

describe("MollifierDrainer.start/stop", () => {
  redisTest("start polls and processes, stop halts the loop", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      ...noopOptions,
    });

    const handled: string[] = [];
    const handler = async (input: { runId: string }) => {
      handled.push(input.runId);
    };

    const drainer = new MollifierDrainer({
      buffer,
      handler,
      concurrency: 5,
      maxAttempts: 3,
      isRetryable: () => false,
      pollIntervalMs: 20,
      logger: new Logger("test-drainer", "log"),
    });

    try {
      await buffer.accept({ runId: "live_1", envId: "env_a", orgId: "org_1", payload: "{}" });
      await buffer.accept({ runId: "live_2", envId: "env_a", orgId: "org_1", payload: "{}" });

      drainer.start();

      const deadline = Date.now() + 5_000;
      while (handled.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      await drainer.stop();

      expect(new Set(handled)).toEqual(new Set(["live_1", "live_2"]));
    } finally {
      await buffer.close();
    }
  });

  redisTest("stop returns after timeoutMs even if a handler is hung", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      ...noopOptions,
    });

    let handlerStarted = false;
    const handler = async () => {
      handlerStarted = true;
      await new Promise<void>(() => {});
    };

    const drainer = new MollifierDrainer({
      buffer,
      handler,
      concurrency: 1,
      maxAttempts: 3,
      isRetryable: () => false,
      pollIntervalMs: 20,
      logger: new Logger("test-drainer", "log"),
    });

    try {
      await buffer.accept({ runId: "hung", envId: "env_a", orgId: "org_1", payload: "{}" });

      drainer.start();

      const deadline = Date.now() + 2_000;
      while (!handlerStarted && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(handlerStarted).toBe(true);

      const stopStart = Date.now();
      await drainer.stop({ timeoutMs: 500 });
      const stopElapsed = Date.now() - stopStart;

      // Allow a small jitter window below `timeoutMs` — Node's setTimeout can
      // fire a millisecond or two early under CI load. The behaviour we're
      // pinning is "stop honors the deadline instead of waiting for the hung
      // handler indefinitely", not millisecond-precise timing.
      expect(stopElapsed).toBeGreaterThanOrEqual(450);
      expect(stopElapsed).toBeLessThan(2_000);
    } finally {
      await buffer.close();
    }
  });
});

describe("MollifierDrainer concurrency cap", () => {
  redisTest(
    "runOnce never exceeds configured concurrency in flight",
    { timeout: 30_000 },
    async ({ redisContainer }) => {
      const buffer = new MollifierBuffer({
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        ...noopOptions,
      });

      const concurrency = 3;
      const envCount = 12;
      let inflight = 0;
      let peak = 0;
      let handlerCalls = 0;
      const handler = async () => {
        handlerCalls++;
        inflight++;
        if (inflight > peak) peak = inflight;
        // Sleep long enough that handlers definitely overlap if scheduling
        // allowed it — the assertion is meaningful only if multiple handlers
        // would be running simultaneously without the cap.
        await new Promise((r) => setTimeout(r, 75));
        inflight--;
      };

      const drainer = new MollifierDrainer({
        buffer,
        handler,
        concurrency,
        maxAttempts: 1,
        isRetryable: () => false,
        logger: new Logger("test-drainer", "log"),
      });

      try {
        // One entry per (env, org) so runOnce sees `envCount` distinct
        // orgs as scheduling candidates and pLimits them through
        // pLimit(concurrency). Spread across orgs (not envs in one org)
        // because the drainer picks one env per org per tick — a single
        // org with 12 envs would only see 1 pop per tick.
        for (let i = 0; i < envCount; i++) {
          await buffer.accept({
            runId: `run_${i}`,
            envId: `env_${i}`,
            orgId: `org_${i}`,
            payload: "{}",
          });
        }

        const result = await drainer.runOnce();
        expect(result.drained).toBe(envCount);
        expect(handlerCalls).toBe(envCount);
        expect(peak).toBeGreaterThan(1); // concurrency is real, not serialised
        expect(peak).toBeLessThanOrEqual(concurrency);
      } finally {
        await buffer.close();
      }
    },
  );
});
