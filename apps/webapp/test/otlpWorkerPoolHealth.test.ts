import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOtlpWorkerPoolHealthy, OtlpWorkerPool } from "~/v3/otlpWorkerPool.server";

const echoWorker = fileURLToPath(new URL("./fixtures/otlpEchoWorker.cjs", import.meta.url));
const exitWorker = fileURLToPath(new URL("./fixtures/otlpExitWorker.cjs", import.meta.url));

const config = { spanAttributeValueLengthLimit: 8192, defaultEventStore: "clickhouse" };

describe("isOtlpWorkerPoolHealthy", () => {
  let pool: OtlpWorkerPool | undefined;

  afterEach(async () => {
    await pool?.shutdown();
    pool = undefined;
  });

  it("is healthy before the pool has been created", () => {
    expect(isOtlpWorkerPoolHealthy()).toBe(true);
  });

  it("is healthy while the pool has alive workers", async () => {
    pool = new OtlpWorkerPool(2, echoWorker, []);

    await pool.runTransform("traces", new Uint8Array([1]), config);

    expect(pool.aliveWorkers).toBe(2);
    expect(isOtlpWorkerPoolHealthy(pool)).toBe(true);
  });

  it("is unhealthy once every worker has died", async () => {
    const dying = new OtlpWorkerPool(1, exitWorker, []);
    pool = dying;

    await vi.waitFor(
      () => {
        expect(dying.aliveWorkers).toBe(0);
        expect(isOtlpWorkerPoolHealthy(dying)).toBe(false);
      },
      { timeout: 5000, interval: 20 }
    );
  });

  it("is unhealthy after shutdown", async () => {
    pool = new OtlpWorkerPool(1, echoWorker, []);

    await pool.shutdown();

    expect(pool.aliveWorkers).toBe(0);
    expect(isOtlpWorkerPoolHealthy(pool)).toBe(false);
  });
});
