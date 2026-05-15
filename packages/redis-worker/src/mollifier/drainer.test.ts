import { redisTest } from "@internal/testcontainers";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@trigger.dev/core/logger";
import { MollifierBuffer } from "./buffer.js";
import { MollifierDrainer } from "./drainer.js";
import { serialiseSnapshot } from "./schemas.js";

const noopOptions = {
  entryTtlSeconds: 600,
  logger: new Logger("test", "log"),
};

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

    const handler = vi.fn(async () => {});
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
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run_1",
          envId: "env_a",
          orgId: "org_1",
          payload: { foo: 1 },
        }),
      );

      const entry = await buffer.getEntry("run_1");
      expect(entry).toBeNull();
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

    const handler = vi.fn(async () => {});
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
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await buffer.close();
    }
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
    const handler = vi.fn(async () => {
      calls++;
      throw new Error("transient");
    });

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

      await drainer.runOnce();
      const after3 = await buffer.getEntry("run_r");
      expect(after3!.status).toBe("FAILED");
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

    const handler = vi.fn(async () => {
      throw new Error("validation failure");
    });

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

      await drainer.runOnce();

      const entry = await buffer.getEntry("run_nr");
      expect(entry!.status).toBe("FAILED");
      expect(entry!.lastError).toEqual({ code: "Error", message: "validation failure" });
    } finally {
      await buffer.close();
    }
  });

  redisTest("multi-env round-robin: drains one item per env per runOnce", { timeout: 20_000 }, async ({ redisContainer }) => {
    const buffer = new MollifierBuffer({
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      ...noopOptions,
    });

    const handled: string[] = [];
    const handler = vi.fn(async (input: { runId: string }) => {
      handled.push(input.runId);
    });

    const drainer = new MollifierDrainer({
      buffer,
      handler,
      concurrency: 10,
      maxAttempts: 3,
      isRetryable: () => false,
      logger: new Logger("test-drainer", "log"),
    });

    try {
      await buffer.accept({ runId: "a1", envId: "env_a", orgId: "org_1", payload: "{}" });
      await buffer.accept({ runId: "a2", envId: "env_a", orgId: "org_1", payload: "{}" });
      await buffer.accept({ runId: "b1", envId: "env_b", orgId: "org_1", payload: "{}" });

      const r1 = await drainer.runOnce();
      expect(r1.drained).toBe(2);
      expect(new Set(handled)).toEqual(new Set(["a1", "b1"]));

      handled.length = 0;
      const r2 = await drainer.runOnce();
      expect(r2.drained).toBe(1);
      expect(handled).toEqual(["a2"]);
    } finally {
      await buffer.close();
    }
  });
});

// Transient Redis errors used to permanently kill the loop because
// `processOneFromEnv` didn't catch `buffer.pop()` rejections — the error
// bubbled through `Promise.all` → `runOnce` → `loop`'s outer catch and
// left `isRunning = false`. These tests use a stubbed buffer (no Redis
// container) so we can deterministically inject failures from `listEnvs`
// and `pop` without racing against a real client.
describe("MollifierDrainer resilience to transient buffer errors", () => {
  type StubBuffer = Partial<MollifierBuffer> & { [K in keyof MollifierBuffer]?: any };

  function makeStubBuffer(overrides: StubBuffer): MollifierBuffer {
    const base: StubBuffer = {
      listEnvs: async () => [],
      pop: async () => null,
      ack: async () => {},
      requeue: async () => {},
      fail: async () => true,
      getEntry: async () => null,
      close: async () => {},
    };
    return { ...base, ...overrides } as unknown as MollifierBuffer;
  }

  it("survives a transient listEnvs failure and resumes draining", async () => {
    let listCalls = 0;
    const popped: string[] = [];
    const buffer = makeStubBuffer({
      listEnvs: async () => {
        listCalls += 1;
        if (listCalls === 1) {
          throw new Error("simulated redis blip");
        }
        return ["env_a"];
      },
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
      listEnvs: async () => ["bad", "good"],
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
});

describe("MollifierDrainer per-tick org cap (cold cache exercises pseudo-orgs)", () => {
  // Bounding fan-out prevents one runOnce from queuing thousands of
  // processOneFromEnv jobs when `mollifier:envs` is unexpectedly large.
  // These stub-buffer tests never return entries (pop = null), so the
  // env→org cache never populates and every env behaves as its own
  // pseudo-org. That makes the org-level cap functionally equivalent to
  // a per-env cap in this regime, which is exactly what we want at cold
  // start. The hierarchical-rotation behaviour is exercised by the org
  // fairness tests further down.
  // These tests use a stub buffer so we can drive the env list count
  // deterministically without provisioning a real Redis with thousands
  // of envs.
  type StubBuffer = Partial<MollifierBuffer> & { [K in keyof MollifierBuffer]?: any };
  function makeStubBuffer(overrides: StubBuffer): MollifierBuffer {
    const base: StubBuffer = {
      listEnvs: async () => [],
      pop: async () => null,
      ack: async () => {},
      requeue: async () => {},
      fail: async () => true,
      getEntry: async () => null,
      close: async () => {},
    };
    return { ...base, ...overrides } as unknown as MollifierBuffer;
  }

  it("processes at most maxOrgsPerTick envs per runOnce", async () => {
    const allEnvs = Array.from({ length: 20 }, (_, i) => `env_${i}`);
    const popped: string[] = [];
    const buffer = makeStubBuffer({
      listEnvs: async () => allEnvs,
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
      listEnvs: async () => allEnvs,
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
      listEnvs: async () => allEnvs,
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
      listEnvs: async () => allEnvs,
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

    const buffer = makeStubBuffer({
      listEnvs: async () =>
        [...queues.keys()].filter((k) => (queues.get(k)?.length ?? 0) > 0),
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
    // Org-level fairness analogue of the env-level no-starvation test.
    // Org A has many envs each with many entries (a noisy tenant). Org B
    // has a single env with a single entry. The drainer's per-env rotation
    // means org_B's env still gets a turn each cycle — its single entry
    // is drained within (envs.length - sliceSize + 1) ticks regardless of
    // how much pressure org_A is applying through its many envs.
    //
    // The buffer doesn't track orgs as a separate axis (each entry just
    // carries orgId on its payload); fairness across orgs is therefore an
    // emergent property of fairness across envs. This test pins that
    // property: org-level drainage latency is bounded by the env rotation,
    // not by total org throughput.
    const orgAEnvs = Array.from({ length: 6 }, (_, i) => `env_orgA_${i}`);
    const orgBEnv = "env_orgB_only";
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
      listEnvs: async () =>
        [...queues.keys()].filter((k) => (queues.get(k)?.length ?? 0) > 0),
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
      maxOrgsPerTick: 4, // < 7 envs, exercises slicing
      logger: new Logger("test-drainer", "log"),
    });

    // 7 envs (6 from org_A + 1 from org_B), sliceSize=4 → worst-case wait
    // for org_B's env is `envs.length - sliceSize + 1 = 4` ticks.
    const ticksUntilOrgBDrained = await (async () => {
      for (let tick = 1; tick <= 7; tick++) {
        await drainer.runOnce();
        if ((drainedByOrg["org_B"] ?? 0) > 0) return tick;
      }
      return Infinity;
    })();

    expect(ticksUntilOrgBDrained).toBeLessThanOrEqual(4);
    // Sanity: org_A is being drained too (not starved itself) but its many
    // envs are far from empty.
    expect(drainedByOrg["org_A"]).toBeGreaterThan(0);
    for (const e of orgAEnvs) {
      expect(queues.get(e)!.length).toBeGreaterThan(0);
    }
  });

  it("after cache warm-up, a heavy org with many envs gets ~1 slot per tick, not N slots", async () => {
    // The hierarchical rotation property: once the env→org cache is
    // populated, an org with N envs gets the SAME per-tick scheduling slot
    // as an org with 1 env, instead of N slots (which is what per-env
    // rotation would give). Sustained-run drainage rate is therefore
    // determined by org count, not env count.
    //
    // Org_A: 6 envs × 100 entries (a noisy tenant).
    // Org_B: 1 env × 100 entries (a quiet tenant).
    // Per-env rotation would drain org_A 6× faster than org_B. The org-
    // level rotation drains them at ~1:1 over a sustained window.
    const orgAEnvs = Array.from({ length: 6 }, (_, i) => `env_orgA_${i}`);
    const orgBEnv = "env_orgB_only";
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
      listEnvs: async () =>
        [...queues.keys()].filter((k) => (queues.get(k)?.length ?? 0) > 0),
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

    // Warm the cache: first tick treats every env as its own pseudo-org
    // (per-env behaviour). After tick 1 the cache is populated and
    // subsequent ticks bucket by real org.
    await drainer.runOnce();

    // Drive 20 more ticks with the cache hot. Under hierarchical rotation
    // each tick drains 1 from org_A and 1 from org_B.
    for (let i = 0; i < 20; i++) {
      await drainer.runOnce();
    }

    // Under per-env rotation, drainedByOrg.org_A would be ~6× larger than
    // drainedByOrg.org_B. Under hierarchical, the ratio is ~1.
    expect(drainedByOrg["org_A"]).toBeGreaterThan(0);
    expect(drainedByOrg["org_B"]).toBeGreaterThan(0);
    const ratio = drainedByOrg["org_A"]! / drainedByOrg["org_B"]!;
    // Allow a generous band to absorb cold-start tick 1 (which favoured
    // org_A by 6 because each env was its own pseudo-org). Within 2× is
    // the bar; under per-env it would be ~6×.
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("within an org, envs are rotated round-robin across ticks", async () => {
    // After cache warm-up an org with N envs picks one env per tick,
    // cycling through its envs. This test verifies the inner cursor
    // advances by 1 per visit to the org (analogous to head-of-line
    // fairness within a slice, but at the env-within-org layer).
    const orgEnvs = ["env_x", "env_y", "env_z"];
    const orgId = "org_solo";
    const queues = new Map<string, number>();
    for (const e of orgEnvs) queues.set(e, 100);

    const poppedSequence: string[] = [];
    const buffer = makeStubBuffer({
      listEnvs: async () =>
        [...queues.keys()].filter((k) => (queues.get(k) ?? 0) > 0),
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

    // Tick 1: cold cache, each env is its own pseudo-org → all 3 popped.
    await drainer.runOnce();
    poppedSequence.length = 0;

    // Now cache is warm; all 3 envs are in `org_solo`. Each tick should
    // drain exactly one env from the org bucket, rotating through them.
    for (let i = 0; i < 6; i++) {
      await drainer.runOnce();
    }

    // 6 ticks × 1 env per tick = 6 pops, cycling x, y, z, x, y, z (in
    // some sort order). The exact sequence depends on the bucket's
    // internal cursor — but every env should be picked exactly twice.
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
  // Helper duplicated locally to keep these tests self-contained.
  type StubBuffer = Partial<MollifierBuffer> & { [K in keyof MollifierBuffer]?: any };
  function makeStubBuffer(overrides: StubBuffer): MollifierBuffer {
    const base: StubBuffer = {
      listEnvs: async () => [],
      pop: async () => null,
      ack: async () => {},
      requeue: async () => {},
      fail: async () => true,
      getEntry: async () => null,
      close: async () => {},
    };
    return { ...base, ...overrides } as unknown as MollifierBuffer;
  }

  it("a malformed payload is treated as a non-retryable handler error and goes terminal", async () => {
    // The deserialise call lives inside processEntry's try, so a JSON parse
    // failure is caught by the same handler-error branch. With
    // isRetryable=false, the entry transitions directly to FAILED — the
    // handler is never invoked because the throw happens before the
    // handler call.
    let handlerCalled = false;
    const failedEntries: Array<{ runId: string; error: { code: string; message: string } }> = [];
    const buffer = makeStubBuffer({
      listEnvs: async () => ["env_a"],
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
    // handler-side work completed. Phase 2's engine-replay handler will
    // need idempotency to absorb the re-execution this implies on retry,
    // OR ack should be lifted out of the try block.
    let handlerCalls = 0;
    const failedEntries: string[] = [];
    const buffer = makeStubBuffer({
      listEnvs: async () => ["env_a"],
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
      listEnvs: async () => {
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

  it("rotation cursors and env→org cache reset on start() so a stop+start cycle begins fresh", async () => {
    const allEnvs = ["env_a", "env_b", "env_c", "env_d", "env_e", "env_f"];
    const popLog: string[] = [];
    const buffer = makeStubBuffer({
      listEnvs: async () => allEnvs,
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
      listEnvs: async () => {
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
    const handler = vi.fn(async (input: { runId: string }) => {
      handled.push(input.runId);
    });

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
    const handler = vi.fn(async () => {
      handlerStarted = true;
      await new Promise<void>(() => {});
    });

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

      expect(stopElapsed).toBeGreaterThanOrEqual(500);
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
      const handler = vi.fn(async () => {
        inflight++;
        if (inflight > peak) peak = inflight;
        // Sleep long enough that handlers definitely overlap if scheduling
        // allowed it — the assertion is meaningful only if multiple handlers
        // would be running simultaneously without the cap.
        await new Promise((r) => setTimeout(r, 75));
        inflight--;
      });

      const drainer = new MollifierDrainer({
        buffer,
        handler,
        concurrency,
        maxAttempts: 1,
        isRetryable: () => false,
        logger: new Logger("test-drainer", "log"),
      });

      try {
        // One entry per env so runOnce sees `envCount` candidates and pLimits
        // them through pLimit(concurrency).
        for (let i = 0; i < envCount; i++) {
          await buffer.accept({
            runId: `run_${i}`,
            envId: `env_${i}`,
            orgId: "org_1",
            payload: "{}",
          });
        }

        const result = await drainer.runOnce();
        expect(result.drained).toBe(envCount);
        expect(handler).toHaveBeenCalledTimes(envCount);
        expect(peak).toBeGreaterThan(1); // concurrency is real, not serialised
        expect(peak).toBeLessThanOrEqual(concurrency);
      } finally {
        await buffer.close();
      }
    },
  );
});
