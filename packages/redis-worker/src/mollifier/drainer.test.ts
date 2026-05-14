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

describe("MollifierDrainer per-tick env cap", () => {
  // Bounding fan-out prevents one runOnce from queuing thousands of
  // processOneFromEnv jobs when `mollifier:envs` is unexpectedly large.
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

  it("processes at most maxEnvsPerTick envs per runOnce", async () => {
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
      maxEnvsPerTick: 5,
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
      maxEnvsPerTick: 4,
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
      maxEnvsPerTick: sliceSize,
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
      maxEnvsPerTick: 100, // way above n
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
    expect(popsPerTick[0][0]).not.toEqual(popsPerTick[1][0]);
    expect(popsPerTick[1][0]).not.toEqual(popsPerTick[2][0]);
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
      maxEnvsPerTick: 4, // < 7 envs so we exercise slicing
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
