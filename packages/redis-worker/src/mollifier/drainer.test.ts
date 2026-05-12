import { redisTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
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
