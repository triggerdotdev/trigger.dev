import { redisTest } from "@internal/testcontainers";
import Redis from "ioredis";
import { expect } from "vitest";
import { RedisLogsSearchProjectorStore } from "~/services/logsSearchProjectorRedisStore.server";

const at = (value: string) => new Date(value);

redisTest("coordinates projection leases with token-safe release", async ({ redisOptions }) => {
  const redis = new Redis(redisOptions);
  const store = new RedisLogsSearchProjectorStore(redis);

  expect(await store.acquireLease("preview-owner", "preview", 60_000)).toBe(true);
  expect(await store.acquireLease("finalized-owner", "finalized", 60_000)).toBe(false);
  await expect(store.readLeaseStatus()).resolves.toMatchObject({ mode: "preview" });

  await store.releaseLease("wrong-owner", "preview");
  expect(await store.acquireLease("finalized-owner", "finalized", 60_000)).toBe(false);

  await store.releaseLease("preview-owner", "preview");
  expect(await store.acquireLease("finalized-owner", "finalized", 60_000)).toBe(true);

  await redis.quit();
});

redisTest(
  "initializes and advances the preview watermark monotonically",
  async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    const store = new RedisLogsSearchProjectorStore(redis);
    const initial = at("2026-08-14T12:00:00.000Z");
    const next = at("2026-08-14T12:00:05.000Z");
    const laterInitialization = at("2026-08-14T12:01:00.000Z");

    await expect(store.initializePreviewWatermark(initial)).resolves.toEqual(initial);
    await expect(store.initializePreviewWatermark(laterInitialization)).resolves.toEqual(initial);
    await expect(store.advancePreviewWatermark(next)).resolves.toBe(true);
    await expect(store.advancePreviewWatermark(initial)).resolves.toBe(false);
    await expect(store.getPreviewWatermark()).resolves.toEqual(next);

    await redis.quit();
  }
);
