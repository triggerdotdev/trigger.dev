// readCompletedRecords is the store half of the completed-waitpoint resolver. Proven against a REAL
// Redis (redisTest FLUSHALLs per test): a completed record comes back with its frozen record blob and
// completion envelope, an absent id is simply missing from the map (never an error), and a PENDING
// record reports PENDING so the resolver can reject it.
import { redisTest } from "@internal/testcontainers";
import { type RedisOptions } from "@internal/redis";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { createRedisClient } from "@internal/redis";
import { runResultKey, waitpointKeys } from "./keys.js";
import { WaitpointFanoutWorker } from "./fanoutWorker.js";
import {
  WaitpointStoreCoordinator,
  type WaitpointCompletion,
  type WaitpointRecordInput,
} from "./storeCoordinator.js";

const ENV_ID = "env_1";
const PROJECT_ID = "proj_1";
const NOW = "2026-08-21T12:00:00.000Z";

function coordinator(redisOptions: RedisOptions) {
  return new WaitpointStoreCoordinator({ redisOptions });
}

function record(id: string, overrides: Partial<WaitpointRecordInput> = {}): WaitpointRecordInput {
  return {
    id,
    friendlyId: `waitpoint_${id}`,
    type: "MANUAL",
    environmentId: ENV_ID,
    projectId: PROJECT_ID,
    createdAt: NOW,
    updatedAt: NOW,
    userProvidedIdempotencyKey: false,
    tags: [],
    ...overrides,
  };
}

function completion(overrides: Partial<WaitpointCompletion> = {}): WaitpointCompletion {
  return {
    completedAt: "2026-08-21T12:34:56.000Z",
    outputType: "application/json",
    outputIsError: false,
    output: { inline: '{"value":42}' },
    ...overrides,
  };
}

describe("WaitpointStoreCoordinator.readCompletedRecords", () => {
  redisTest(
    "returns the frozen record and completion for a completed waitpoint",
    async ({ redisOptions }) => {
      const store = coordinator(redisOptions);
      try {
        const id = generateWaitpointId("RUN");
        const rec = record(id, { type: "RUN", completedByTaskRunId: "run_child" });
        await store.createIfAbsent({ record: rec, status: "PENDING" });
        await store.complete({ waitpointId: id, completion: completion() });

        const out = await store.readCompletedRecords([id]);

        expect(out.size).toBe(1);
        const entry = out.get(id)!;
        expect(entry.status).toBe("COMPLETED");
        expect(entry.record).toEqual(rec);
        expect(entry.completion).toEqual(completion());
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("omits an absent id rather than erroring", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const present = generateWaitpointId("MANUAL");
      const absent = generateWaitpointId("MANUAL");
      await store.createIfAbsent({ record: record(present), status: "PENDING" });
      await store.complete({ waitpointId: present, completion: completion() });

      const out = await store.readCompletedRecords([present, absent]);

      // Absence is reported as omission, not a throw: the resolver decides it is an integrity error.
      expect(out.has(present)).toBe(true);
      expect(out.has(absent)).toBe(false);
    } finally {
      await store.quit();
    }
  });

  redisTest("reports a still-PENDING record as PENDING", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const id = generateWaitpointId("MANUAL");
      await store.createIfAbsent({ record: record(id), status: "PENDING" });

      const out = await store.readCompletedRecords([id]);

      const entry = out.get(id)!;
      expect(entry.status).toBe("PENDING");
      expect(entry.completion).toBeUndefined();
    } finally {
      await store.quit();
    }
  });

  redisTest("reads each distinct id once for a repeated id list", async ({ redisOptions }) => {
    const store = coordinator(redisOptions);
    try {
      const id = generateWaitpointId("BATCH");
      await store.createIfAbsent({ record: record(id, { type: "BATCH" }), status: "PENDING" });
      await store.complete({ waitpointId: id, completion: completion() });

      const out = await store.readCompletedRecords([id, id, id]);

      expect(out.size).toBe(1);
      expect(out.get(id)!.status).toBe("COMPLETED");
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "surfaces a Redis failure as a throw, never as an absent record",
    async ({ redisOptions }) => {
      // A quit()ted client makes the HMGET reject: the failure must PROPAGATE, so the resolver can retry,
      // and never be seen as the record simply being absent.
      const store = coordinator(redisOptions);
      const id = generateWaitpointId("MANUAL");
      await store.createIfAbsent({ record: record(id), status: "PENDING" });
      await store.complete({ waitpointId: id, completion: completion() });
      await store.quit();

      await expect(store.readCompletedRecords([id])).rejects.toBeInstanceOf(Error);
    }
  );
});

redisTest(
  "parent snapshots retain atomic completed metadata through acknowledgement and terminal cleanup",
  async ({ redisOptions }) => {
    const store = new WaitpointStoreCoordinator({ redisOptions });
    const redis = createRedisClient(redisOptions);
    const worker = new WaitpointFanoutWorker({ coordinator: store, enabled: false });
    try {
      const early = generateWaitpointId("DATETIME");
      const late = generateWaitpointId("RUN");
      const pending = generateWaitpointId("RUN");
      const records = [
        record(early, { type: "DATETIME", completedAfter: NOW }),
        record(late, { type: "RUN", completedByTaskRunId: "run_child" }),
      ];
      for (const rec of records) await store.createIfAbsent({ record: rec, status: "PENDING" });
      await store.complete({ waitpointId: early, completion: completion() });
      await store.createIfAbsent({ record: record(pending), status: "PENDING" });
      await store.registerBlocks({
        runId: "run_parent",
        blockId: "block_parent",
        edges: [early, late, pending].map((waitpointId) => ({ waitpointId, createdAt: NOW })),
      });
      await store.complete({ waitpointId: late, completion: completion() });
      expect((await worker.visit(late)).outcome).toBe("drained");
      // Simulate expiry only after both the registration and fanout receipts are durable.
      await redis.del(waitpointKeys(early).record, waitpointKeys(late).record);
      expect((await store.readCompletedRecords([early, late])).size).toBe(0);
      expect((await store.readBlockState("run_parent")).pendingIds).toEqual([pending]);
      const retained = await store.readCompletedRecords([early, late], "run_parent");
      for (const rec of records)
        expect(retained.get(rec.id)).toEqual({
          status: "COMPLETED",
          record: rec,
          completion: completion(),
        });
      expect((await store.readCompletedRecords([early], "run_other")).size).toBe(0);
      await store.clearBlockState({ runId: "run_parent", blockId: "block_parent" });
      expect((await store.readCompletedRecords([early, late], "run_parent")).size).toBe(2);
      expect(await redis.pttl(runResultKey("run_parent"))).toBe(-1);
      await store.cleanupRunBlockState({ runId: "run_parent", reason: "resume" });
      expect(await redis.pttl(runResultKey("run_parent"))).toBe(-1);
      await store.releaseRunWatchers({ runId: "run_parent", reason: "terminal" });
      expect(await redis.pttl(runResultKey("run_parent"))).toBeGreaterThan(0);
      expect(
        (
          await store.deliverCompletion({
            runId: "run_parent",
            blockId: "block_parent",
            waitpointId: early,
            completion: completion(),
            record: records[0],
          })
        ).outcome
      ).toBe("terminal");
    } finally {
      await worker.stop();
      await redis.quit();
      await store.quit();
    }
  }
);
