import { expect } from "vitest";
import Redis from "ioredis";
import { heteroRunOpsWithRedisTest } from "./index";

heteroRunOpsWithRedisTest(
  "provides both Postgres clients and a live Redis",
  async ({ prisma14, prisma17, redisOptions }) => {
    const a = await prisma14.$queryRaw`SELECT 1 as ok`;
    const b = await prisma17.$queryRaw`SELECT 1 as ok`;
    expect(a).toEqual([{ ok: 1 }]);
    expect(b).toEqual([{ ok: 1 }]);

    const redis = new Redis(redisOptions);
    try {
      expect(await redis.dbsize()).toBe(0);
      await redis.set("k", "v");
      expect(await redis.get("k")).toBe("v");
    } finally {
      await redis.quit();
    }
  },
  120_000
);
