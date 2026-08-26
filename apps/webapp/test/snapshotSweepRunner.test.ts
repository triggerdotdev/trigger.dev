import { redisTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { createRedisClient } from "@internal/redis";
import { buildSnapshotSweepRunner } from "~/v3/snapshotSweepRunner.server";

const LOCK_KEY = "snapshot-sweep:lock";
const CLEAN = { scanned: 1, expired: 0, deleted: 0, skipped: 1, partial: false };

function opts() {
  return { deadline: Date.now() + 10_000, signal: new AbortController().signal };
}

redisTest("reports completed and releases the lock", async ({ redisOptions }) => {
  const client = createRedisClient(redisOptions);
  try {
    const runner = buildSnapshotSweepRunner({
      client,
      sweep: async () => CLEAN,
      lockTtlMs: 60_000,
    });

    expect((await runner(opts())).outcome).toBe("completed");
    expect(await client.get(LOCK_KEY)).toBeNull();
  } finally {
    await client.quit();
  }
});

redisTest("reports partial when the pass truncates", async ({ redisOptions }) => {
  const client = createRedisClient(redisOptions);
  try {
    const runner = buildSnapshotSweepRunner({
      client,
      sweep: async () => ({ ...CLEAN, partial: true }),
      lockTtlMs: 60_000,
    });

    const result = await runner(opts());
    expect(result.outcome).toBe("partial");
    expect(result.counts).toMatchObject({ partial: true });
  } finally {
    await client.quit();
  }
});

redisTest("skips without running when the lock is held", async ({ redisOptions }) => {
  const client = createRedisClient(redisOptions);
  try {
    await client.set(LOCK_KEY, "someone-else", "PX", 60_000);
    let ran = false;

    const runner = buildSnapshotSweepRunner({
      client,
      sweep: async () => {
        ran = true;
        return CLEAN;
      },
      lockTtlMs: 60_000,
    });

    expect((await runner(opts())).outcome).toBe("skipped_locked");
    expect(ran).toBe(false);
    expect(await client.get(LOCK_KEY)).toBe("someone-else");
  } finally {
    await client.quit();
  }
});

redisTest("reports failed and still releases its own lock", async ({ redisOptions }) => {
  const client = createRedisClient(redisOptions);
  try {
    const runner = buildSnapshotSweepRunner({
      client,
      sweep: async () => {
        throw new Error("redis down mid-pass");
      },
      lockTtlMs: 60_000,
    });

    // Resolving is deliberate: the worker reschedules a cron job on acknowledge as well as on the
    // dead-letter path, so a failure needs no throw to keep the chain alive.
    expect((await runner(opts())).outcome).toBe("failed");
    expect(await client.get(LOCK_KEY)).toBeNull();
  } finally {
    await client.quit();
  }
});

redisTest("an overrun pass cannot delete a successor's lock", async ({ redisOptions }) => {
  const client = createRedisClient(redisOptions);
  try {
    const runner = buildSnapshotSweepRunner({
      client,
      fence: () => "first-pass",
      // Stand in for the lock expiring mid-pass and a successor claiming it.
      sweep: async () => {
        await client.set(LOCK_KEY, "successor", "PX", 60_000);
        return CLEAN;
      },
      lockTtlMs: 60_000,
    });

    await runner(opts());

    expect(await client.get(LOCK_KEY)).toBe("successor");
  } finally {
    await client.quit();
  }
});

redisTest("reports aborted when shutdown cancels the pass", async ({ redisOptions }) => {
  const client = createRedisClient(redisOptions);
  try {
    const controller = new AbortController();
    const runner = buildSnapshotSweepRunner({
      client,
      sweep: async () => {
        controller.abort();
        return CLEAN;
      },
      lockTtlMs: 60_000,
    });

    const result = await runner({ deadline: Date.now() + 10_000, signal: controller.signal });
    expect(result.outcome).toBe("aborted");
    expect(await client.get(LOCK_KEY)).toBeNull();
  } finally {
    await client.quit();
  }
});
