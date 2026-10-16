import { redisTest } from "@internal/testcontainers";
import Redis from "ioredis";
import { describe, expect, vi } from "vitest";
import {
  planProvisioningStatusKey,
  readPlanProvisioningStatus,
} from "../app/v3/services/planProvisioningStatus.server.js";

vi.setConfig({ testTimeout: 30_000 });

describe("readPlanProvisioningStatus", () => {
  redisTest("reads the status billing wrote for the org", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);

    try {
      for (const status of ["pending", "succeeded", "failed"] as const) {
        await redis.hset(planProvisioningStatusKey("org_1"), { status, changeId: "change_1" });
        await expect(readPlanProvisioningStatus(redis, "org_1")).resolves.toBe(status);
      }
      await expect(readPlanProvisioningStatus(redis, "org_2")).resolves.toBeUndefined();
    } finally {
      redis.disconnect();
    }
  });

  redisTest("ignores a status it doesn't know", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);

    try {
      await redis.hset(planProvisioningStatusKey("org_1"), { status: "applying" });
      await expect(readPlanProvisioningStatus(redis, "org_1")).resolves.toBeUndefined();
    } finally {
      redis.disconnect();
    }
  });

  redisTest("shows nothing when Redis can't be reached", async ({ redisOptions }) => {
    const redis = new Redis({ ...redisOptions, lazyConnect: true, maxRetriesPerRequest: 0 });
    redis.disconnect();

    await expect(readPlanProvisioningStatus(redis, "org_1")).resolves.toBeUndefined();
  });
});
