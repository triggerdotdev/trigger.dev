import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { runBlockKeys, waitpointKeys } from "./keys.js";
import { WaitpointStoreCoordinator, type WaitpointRecordInput } from "./storeCoordinator.js";

describe("registration replay", () => {
  redisTest(
    "registration replay consumes its fenced receipt after source expiry",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      const id = generateWaitpointId("RUN");
      const now = new Date().toISOString();
      const record: WaitpointRecordInput = {
        id,
        friendlyId: `waitpoint_${id}`,
        type: "RUN",
        environmentId: "env",
        projectId: "project",
        createdAt: now,
        updatedAt: now,
        completedByTaskRunId: "child",
        userProvidedIdempotencyKey: false,
        tags: [],
      };
      const args = {
        runId: "parent",
        blockId: "block",
        absorptionId: "absorption",
        edges: [
          { waitpointId: id, type: "RUN" as const, createdAt: now, spanIdToComplete: "span" },
        ],
      };
      try {
        await store.createIfAbsent({
          record,
          status: "COMPLETED",
          completion: {
            completedAt: now,
            outputType: "application/json",
            outputIsError: true,
            output: { inline: '{"message":"failed"}' },
          },
        });
        await store.registerBlocks(args);
        expect((await store.readBlockState(args.runId)).handoff).toBe("owed");
        // Expire the source after receipt delivery but before the caller schedules continuation.
        await redis.pexpire(waitpointKeys(id).record, 1);
        await expect
          .poll(() => redis.exists(waitpointKeys(id).record), {
            timeout: 5_000,
            interval: 20,
            message: "completed source record never expired",
          })
          .toBe(0);
        expect((await store.readCompletedRecords([id], args.runId)).size).toBe(1);
        const replay = await store.registerBlocks(args);
        expect(replay.pendingOfRequested).toBe(0);
        expect(replay.storePendingTotal).toBe(0);
        expect(replay.cachedSpanCompletions).toEqual([
          {
            spanId: "span",
            spanCreatedAt: now,
            blockedRunId: "parent",
            hasError: true,
            cachedRunId: "child",
          },
        ]);
        expect((await store.readBlockState(args.runId)).handoff).toBe("owed");
        await store.acknowledgeResumeHandoff({ runId: args.runId, blockId: args.blockId });
        await store.registerBlocks({
          ...args,
          blockId: "next",
          absorptionId: "next",
          expectedPreviousBlockId: args.blockId,
          edges: [],
        });
        expect((await store.registerBlocks(args)).outcome).toBe("stale");
      } finally {
        await redis.quit();
        await store.quit();
      }
    }
  );

  redisTest(
    "registration replay refuses corrupt metadata and cannot infer missing source metadata",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      const id = generateWaitpointId("RUN");
      const now = new Date().toISOString();
      const args = {
        runId: "parent",
        blockId: "block",
        edges: [{ waitpointId: id, type: "RUN" as const, createdAt: now }],
      };
      const completion = {
        completedAt: now,
        outputType: "application/json",
        outputIsError: false,
        output: null,
      };
      try {
        await store.absorbBlockers(args);
        // A metadata-less historical receipt still needs a live, valid source record.
        await store.deliverCompletion({
          runId: args.runId,
          blockId: args.blockId,
          waitpointId: id,
          completion,
        });
        await expect(store.registerBlocks(args)).rejects.toThrow("is not present in the store");
        await redis.hset(
          runBlockKeys(args.runId).done,
          id,
          JSON.stringify({ ...completion, record: { id: "wrong" } })
        );
        await expect(store.registerBlocks(args)).rejects.toThrow("Invalid retained completion");
        await redis.hset(runBlockKeys(args.runId).done, id, "{");
        await expect(store.registerBlocks(args)).rejects.toThrow();
      } finally {
        await redis.quit();
        await store.quit();
      }
    }
  );
});
