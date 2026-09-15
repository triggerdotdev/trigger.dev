// Atomic recovery-stream settlement: a resolved (non-retry) recovery entry must be ACKed out of the
// consumer group's pending list AND deleted from the stream. Doing these as two separate commands can
// crash between them and leak a stream member (ACKed but never deleted), growing the recovery stream
// unbounded for a run that keeps getting quarantined. `PendingIndex.settle` does both in one Lua op, so
// only the fully-settled or fully-unsettled state is observable. Real Redis (testcontainers), no mocks;
// the "crash between commands" hazard is shown with a fault injector (the first command run alone).
import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { PendingIndex, RECOVERY_CONSUMER_GROUP } from "./pendingIndex.js";
import { pendingStreamKey, runToPartition } from "./snapshotKeys.js";

async function xpendingCount(redis: any, partition: number): Promise<number> {
  const summary = (await redis.xpending(
    pendingStreamKey(partition),
    RECOVERY_CONSUMER_GROUP
  )) as unknown[];
  return Number(summary?.[0] ?? 0);
}

describe("PendingIndex.settle (atomic recovery-stream settlement)", () => {
  redisTest(
    "the old two-command boundary (XACK, then a crash before XDEL) leaks a stream member",
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(redis);
      try {
        const runId = "run_settle_leak";
        const partition = runToPartition(runId);
        await index.ensureGroup(partition);
        const id = await index.add(runId, { runId, transitionToken: "t" });

        // Deliver it so it enters the group's pending list.
        const delivered = await index.readGroup(partition, "consumer-1");
        expect(delivered.map((e) => e.id)).toContain(id);
        expect(await xpendingCount(redis, partition)).toBe(1);

        // Fault injection: the process crashes right after XACK, before XDEL ever runs. XACK removed it
        // from the pending list, but the entry survives in the stream: a leaked member.
        await redis.xack(pendingStreamKey(partition), RECOVERY_CONSUMER_GROUP, id);
        expect(await xpendingCount(redis, partition)).toBe(0);
        expect(await redis.xlen(pendingStreamKey(partition))).toBe(1); // leaked

        // The atomic op cannot reach this half-settled state: settling now cleans up the leaked member.
        await index.settle(partition, id);
        expect(await redis.xlen(pendingStreamKey(partition))).toBe(0);
      } finally {
        await redis.quit();
      }
    }
  );

  redisTest(
    "settle drives both XPENDING and XLEN to zero in one atomic op",
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(redis);
      try {
        const runId = "run_settle_atomic";
        const partition = runToPartition(runId);
        await index.ensureGroup(partition);
        const id = await index.add(runId, { runId, transitionToken: "t" });

        const delivered = await index.readGroup(partition, "consumer-1");
        expect(delivered.map((e) => e.id)).toContain(id);
        expect(await xpendingCount(redis, partition)).toBe(1);
        expect(await redis.xlen(pendingStreamKey(partition))).toBe(1);

        // One production-seam call: both the pending-list ACK and the stream delete happen. Dropping
        // either half of the Lua turns one of these assertions RED.
        await index.settle(partition, id);

        expect(await xpendingCount(redis, partition)).toBe(0);
        expect(await redis.xlen(pendingStreamKey(partition))).toBe(0);
      } finally {
        await redis.quit();
      }
    }
  );

  redisTest(
    "settle is idempotent: a repeat call (lost reply / redelivery) is a safe no-op",
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(redis);
      try {
        const runId = "run_settle_idempotent";
        const partition = runToPartition(runId);
        await index.ensureGroup(partition);
        const id = await index.add(runId, { runId, transitionToken: "t" });
        await index.readGroup(partition, "consumer-1");

        await index.settle(partition, id);
        // A lost reply makes the worker retry the settle; the second call XACKs/XDELs nothing.
        await index.settle(partition, id);

        expect(await xpendingCount(redis, partition)).toBe(0);
        expect(await redis.xlen(pendingStreamKey(partition))).toBe(0);
      } finally {
        await redis.quit();
      }
    }
  );
});
