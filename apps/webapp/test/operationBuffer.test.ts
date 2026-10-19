import { redisTest } from "@internal/testcontainers";
import type { RunMetadataChangeOperation } from "@trigger.dev/core/v3";
import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import {
  InMemoryMetadataOperationBuffer,
  RedisMetadataOperationBuffer,
  type BufferedRunMetadataChangeOperation,
} from "~/services/metadata/operationBuffer.server";

vi.setConfig({ testTimeout: 30_000 });

function op(
  key: string,
  value: string | number,
  type: "set" | "append" = "set"
): BufferedRunMetadataChangeOperation {
  return {
    runId: "ignored",
    timestamp: 0,
    operation: { type, key, value } as RunMetadataChangeOperation,
  };
}

describe("RedisMetadataOperationBuffer", () => {
  redisTest(
    "schedules a run by due time and returns its operations in order",
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      let now = 1_000_000;
      const buffer = new RedisMetadataOperationBuffer({
        redis,
        flushDelayMs: 1000,
        nowMs: () => now,
        keyPrefix: "t1:",
      });

      await buffer.ingest("run_a", [op("foo", "bar")]);
      await buffer.ingest("run_a", [op("count", 1, "append")]);

      expect(await buffer.size()).toBe(1);
      expect(await buffer.claimDue(10)).toEqual([]);

      now += 1000;
      const claims = await buffer.claimDue(10);
      expect(claims).toHaveLength(1);
      expect(claims[0].runId).toBe("run_a");
      expect(claims[0].operations.map((o) => o.operation)).toEqual([
        { type: "set", key: "foo", value: "bar" },
        { type: "append", key: "count", value: 1 },
      ]);

      await buffer.ack(claims[0]);
      expect(await buffer.size()).toBe(0);

      await redis.quit();
    }
  );

  redisTest("only one of two buffers sharing a redis can claim a run", async ({ redisOptions }) => {
    const redisA = new Redis(redisOptions);
    const redisB = new Redis(redisOptions);
    let now = 1_000_000;
    const opts = { flushDelayMs: 0, lockTtlMs: 60_000, nowMs: () => now, keyPrefix: "t2:" };
    const a = new RedisMetadataOperationBuffer({ redis: redisA, ...opts });
    const b = new RedisMetadataOperationBuffer({ redis: redisB, ...opts });

    await a.ingest("run_x", [op("k", "v")]);
    now += 1;

    const aClaims = await a.claimDue(10);
    expect(aClaims).toHaveLength(1);
    expect(await b.claimDue(10, { includeNotYetDue: true })).toEqual([]);

    await a.ack(aClaims[0]);
    expect(await b.size()).toBe(0);

    await redisA.quit();
    await redisB.quit();
  });

  redisTest("requeue keeps the operations for a later claim", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    let now = 1_000_000;
    const buffer = new RedisMetadataOperationBuffer({
      redis,
      flushDelayMs: 0,
      requeueBackoffMs: 0,
      nowMs: () => now,
      keyPrefix: "t3:",
    });

    await buffer.ingest("run_r", [op("a", 1)]);
    now += 1;

    const first = await buffer.claimDue(10);
    expect(first).toHaveLength(1);

    await buffer.requeue(first[0]);
    expect(await buffer.size()).toBe(1);

    now += 1;
    const second = await buffer.claimDue(10);
    expect(second).toHaveLength(1);
    expect(second[0].operations.map((o) => o.operation)).toEqual([
      { type: "set", key: "a", value: 1 },
    ]);

    await buffer.ack(second[0]);
    expect(await buffer.size()).toBe(0);

    await redis.quit();
  });

  redisTest("ack keeps operations that arrived after the claim", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    let now = 1_000_000;
    const buffer = new RedisMetadataOperationBuffer({
      redis,
      flushDelayMs: 0,
      nowMs: () => now,
      keyPrefix: "t4:",
    });

    await buffer.ingest("run_z", [op("a", 1)]);
    now += 1;

    const first = await buffer.claimDue(10);
    expect(first[0].operations).toHaveLength(1);

    await buffer.ingest("run_z", [op("b", 2)]);
    await buffer.ack(first[0]);
    expect(await buffer.size()).toBe(1);

    now += 1;
    const second = await buffer.claimDue(10, { includeNotYetDue: true });
    expect(second[0].operations.map((o) => o.operation)).toEqual([
      { type: "set", key: "b", value: 2 },
    ]);

    await buffer.ack(second[0]);
    expect(await buffer.size()).toBe(0);

    await redis.quit();
  });

  redisTest("claimDue respects the batch size", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    let now = 1_000_000;
    const buffer = new RedisMetadataOperationBuffer({
      redis,
      flushDelayMs: 0,
      nowMs: () => now,
      keyPrefix: "t5:",
    });

    await buffer.ingest("run_1", [op("a", 1)]);
    await buffer.ingest("run_2", [op("a", 1)]);
    await buffer.ingest("run_3", [op("a", 1)]);
    now += 1;

    const first = await buffer.claimDue(2);
    expect(first).toHaveLength(2);

    await Promise.all(first.map((c) => buffer.ack(c)));
    expect(await buffer.size()).toBe(1);

    await redis.quit();
  });

  redisTest("a crashed claim is reclaimable after the lock expires", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    let now = 1_000_000;
    const buffer = new RedisMetadataOperationBuffer({
      redis,
      flushDelayMs: 0,
      lockTtlMs: 200,
      nowMs: () => now,
      keyPrefix: "t6:",
    });

    await buffer.ingest("run_c", [op("a", 1)]);
    now += 1;
    expect(await buffer.claimDue(10)).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 300));
    now += 300;

    const reclaimed = await buffer.claimDue(10);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].operations.map((o) => o.operation)).toEqual([
      { type: "set", key: "a", value: 1 },
    ]);

    await redis.quit();
  });

  redisTest(
    "a pending write outlives a lost claim and is cleared by ack or plain requeue",
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      let now = 1_000_000;
      const buffer = new RedisMetadataOperationBuffer({
        redis,
        flushDelayMs: 0,
        lockTtlMs: 200,
        requeueBackoffMs: 0,
        nowMs: () => now,
        keyPrefix: "t7:",
      });

      await buffer.ingest("run_p", [op("a", 1, "append"), op("b", 2, "append")]);
      now += 1;

      const first = await buffer.claimDue(10);
      expect(first[0].pendingWrite).toBeUndefined();
      expect(await buffer.recordPendingWrite(first[0], 7)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 300));
      now += 300;
      expect(await buffer.recordPendingWrite(first[0], 8)).toBe(false);
      buffer.abandon(first[0]);

      await buffer.ingest("run_p", [op("c", 3, "append")]);
      const second = await buffer.claimDue(10, { includeNotYetDue: true });
      expect(second[0].pendingWrite).toEqual({ metadataVersion: 7, count: 2 });
      expect(second[0].operations).toHaveLength(3);

      await buffer.ack(second[0], { count: 2 });
      const third = await buffer.claimDue(10, { includeNotYetDue: true });
      expect(third[0].pendingWrite).toBeUndefined();
      expect(third[0].operations.map((o) => o.operation)).toEqual([
        { type: "append", key: "c", value: 3 },
      ]);

      await buffer.recordPendingWrite(third[0], 9);
      await buffer.requeue(third[0], { keepPendingWrite: true });
      const fourth = await buffer.claimDue(10, { includeNotYetDue: true });
      expect(fourth[0].pendingWrite).toEqual({ metadataVersion: 9, count: 1 });

      await buffer.requeue(fourth[0]);
      const fifth = await buffer.claimDue(10, { includeNotYetDue: true });
      expect(fifth[0].pendingWrite).toBeUndefined();

      await redis.quit();
    }
  );

  redisTest(
    "releasing an empty claim keeps a run scheduled when operations arrived after the claim",
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const now = 1_000_000;
      const buffer = new RedisMetadataOperationBuffer({
        redis,
        flushDelayMs: 0,
        nowMs: () => now,
        keyPrefix: "t8:",
      });

      await redis.set("t8:{metabuf}:lock:run_e", "token-1");
      await redis.zadd("t8:{metabuf}:dirty", now + 30_000, "run_e");
      await buffer.ingest("run_e", [op("a", 1)]);

      await redis.metabufReleaseEmpty(
        "t8:{metabuf}:lock:run_e",
        "t8:{metabuf}:dirty",
        "t8:{metabuf}:pending:run_e",
        "t8:{metabuf}:ops:run_e",
        "token-1",
        "run_e",
        String(now)
      );

      expect(await redis.get("t8:{metabuf}:lock:run_e")).toBeNull();
      const claims = await buffer.claimDue(10);
      expect(claims.map((c) => c.operations.map((o) => o.operation))).toEqual([
        [{ type: "set", key: "a", value: 1 }],
      ]);

      await redis.quit();
    }
  );

  redisTest(
    "a requeue after the claim was lost leaves the new owner's schedule alone",
    async ({ redisOptions }) => {
      const redisA = new Redis(redisOptions);
      const redisB = new Redis(redisOptions);
      let now = 1_000_000;
      const opts = {
        flushDelayMs: 0,
        lockTtlMs: 200,
        requeueBackoffMs: 0,
        nowMs: () => now,
        keyPrefix: "t9:",
      };
      const a = new RedisMetadataOperationBuffer({ redis: redisA, ...opts });
      const b = new RedisMetadataOperationBuffer({ redis: redisB, ...opts });

      await a.ingest("run_q", [op("a", 1)]);
      now += 1;
      const aClaims = await a.claimDue(10);

      await new Promise((resolve) => setTimeout(resolve, 300));
      now += 300;
      expect(await b.claimDue(10)).toHaveLength(1);
      const scheduled = await redisB.zscore("t9:{metabuf}:dirty", "run_q");

      await a.requeue(aClaims[0]);
      expect(await redisB.zscore("t9:{metabuf}:dirty", "run_q")).toBe(scheduled);

      await Promise.all([redisA.quit(), redisB.quit()]);
    }
  );

  redisTest(
    "an ingest past the per-run cap is rejected without recording its ingest id",
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      const buffer = new RedisMetadataOperationBuffer({
        redis,
        flushDelayMs: 0,
        maxPendingOperationsPerRun: 2,
        keyPrefix: "t11:",
      });

      await buffer.ingest("run_c", [op("a", 1), op("b", 2)]);
      await expect(buffer.ingest("run_c", [op("c", 3)], { ingestId: "late" })).rejects.toThrow(
        /buffered metadata operations/
      );
      expect(await redis.llen("t11:{metabuf}:ops:run_c")).toBe(2);

      const [claim] = await buffer.claimDue(10, { includeNotYetDue: true });
      await buffer.ack(claim);
      await buffer.ingest("run_c", [op("c", 3)], { ingestId: "late" });
      expect(await redis.llen("t11:{metabuf}:ops:run_c")).toBe(1);

      await redis.quit();
    }
  );

  redisTest("ingest with a repeated ingest id appends once", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    const buffer = new RedisMetadataOperationBuffer({ redis, keyPrefix: "t10:" });
    const args = [
      "t10:{metabuf}:ops:run_i",
      "t10:{metabuf}:dirty",
      "t10:{metabuf}:ingest:same-id",
      "run_i",
      "0",
      "60000",
      "0",
      JSON.stringify({ t: 0, o: { type: "increment", key: "n", value: 1 } }),
    ] as const;

    await redis.metabufIngest(...args);
    await redis.metabufIngest(...args);

    expect(await redis.llen("t10:{metabuf}:ops:run_i")).toBe(1);
    expect(await buffer.size()).toBe(1);

    await redis.quit();
  });
});

describe("InMemoryMetadataOperationBuffer", () => {
  it("counts claimed operations toward the per-run cap until they are acked or requeued", async () => {
    const buffer = new InMemoryMetadataOperationBuffer({ maxPendingOperationsPerRun: 2 });

    await buffer.ingest("run_m", [op("a", 1), op("b", 2)]);
    const [claim] = await buffer.claimDue(10);

    await expect(buffer.ingest("run_m", [op("c", 3)])).rejects.toThrow(
      /buffered metadata operations/
    );

    await buffer.ack(claim);
    await buffer.ingest("run_m", [op("c", 3)]);
    expect(await buffer.size()).toBe(1);
  });

  it("keeps counting the part of a claim that a partial requeue did not return", async () => {
    const buffer = new InMemoryMetadataOperationBuffer({ maxPendingOperationsPerRun: 2 });

    await buffer.ingest("run_p", [op("a", 1), op("b", 2)]);
    const [claim] = await buffer.claimDue(10);
    await buffer.requeue({ runId: "run_p", operations: claim.operations.slice(1) });

    await expect(buffer.ingest("run_p", [op("c", 3)])).rejects.toThrow(
      /buffered metadata operations/
    );
  });

  it("treats a cap of zero as unlimited", async () => {
    const buffer = new InMemoryMetadataOperationBuffer({ maxPendingOperationsPerRun: 0 });

    await buffer.ingest("run_z", [op("a", 1), op("b", 2), op("c", 3)]);
    expect(await buffer.size()).toBe(1);
  });

  it("records a repeated ingest id once", async () => {
    const buffer = new InMemoryMetadataOperationBuffer();

    await buffer.ingest("run_d", [op("a", 1, "append")], { ingestId: "same" });
    await buffer.ingest("run_d", [op("a", 1, "append")], { ingestId: "same" });

    const [claim] = await buffer.claimDue(10);
    expect(claim.operations).toHaveLength(1);
  });
});
