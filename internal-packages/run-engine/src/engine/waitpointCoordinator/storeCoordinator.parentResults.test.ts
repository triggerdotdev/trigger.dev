import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { runResultKey, waitpointKeys } from "./keys.js";
import { StoreWaitpointCoordinator } from "./storeWaitpointCoordinator.js";
import { WaitpointStoreCoordinator, type WaitpointRecordInput } from "./storeCoordinator.js";

describe("parent snapshot results", () => {
  redisTest(
    "snapshot results survive replay and newer blocks, then results-only terminal cleanup fences delivery",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const adapter = new StoreWaitpointCoordinator({ store });
      const redis = createRedisClient(redisOptions);
      const now = new Date().toISOString();
      const completion = {
        completedAt: now,
        outputType: "application/json",
        outputIsError: true,
        output: { inline: '{"message":"original"}' },
      };
      const ids = [generateWaitpointId("RUN"), generateWaitpointId("RUN")];
      const records: WaitpointRecordInput[] = ids.map((id) => ({
        id,
        friendlyId: `waitpoint_${id}`,
        type: "RUN",
        environmentId: "env",
        projectId: "project",
        createdAt: now,
        updatedAt: now,
        completedByTaskRunId: `child_${id}`,
        userProvidedIdempotencyKey: false,
        tags: [],
      }));
      try {
        await store.createIfAbsent({ record: records[0]!, status: "COMPLETED", completion });
        await store.registerBlocks({
          runId: "parent",
          blockId: "first",
          edges: [{ waitpointId: ids[0]!, type: "RUN", createdAt: now }],
        });
        await redis.del(waitpointKeys(ids[0]!).record);
        await store.acknowledgeResumeHandoff({ runId: "parent", blockId: "first" });
        await store.clearBlockState({ runId: "parent", blockId: "first" });
        expect((await store.readCompletedRecords([ids[0]!], "parent")).get(ids[0]!)).toEqual({
          status: "COMPLETED",
          record: records[0],
          completion,
        });
        await store.createIfAbsent({ record: records[1]!, status: "PENDING" });
        await store.registerBlocks({
          runId: "parent",
          blockId: "second",
          edges: [{ waitpointId: ids[1]!, type: "RUN", createdAt: now }],
        });
        expect(
          (
            await store.deliverCompletion({
              runId: "parent",
              blockId: "first",
              waitpointId: ids[0]!,
              record: records[0],
              completion: { ...completion, output: { inline: "wrong" } },
            })
          ).outcome
        ).toBe("stale");
        expect(
          (await store.terminalRetainAndClear({ runId: "parent", blockId: "first" })).outcome
        ).toBe("stale");
        expect(await redis.pttl(runResultKey("parent"))).toBe(-1);
        expect(
          (await store.readCompletedRecords([ids[0]!], "parent")).get(ids[0]!)?.completion
        ).toEqual(completion);
        await store.complete({ waitpointId: ids[1]!, completion });
        await store.registerBlocks({
          runId: "parent",
          blockId: "second",
          edges: [{ waitpointId: ids[1]!, type: "RUN", createdAt: now }],
        });
        await store.acknowledgeResumeHandoff({ runId: "parent", blockId: "second" });
        await store.clearBlockState({ runId: "parent", blockId: "second" });
        expect((await store.readCompletedRecords(ids, "parent")).size).toBe(2);
        await adapter.releaseRunBlockers({ runId: "parent", reason: "terminal" });
        expect(await redis.pttl(runResultKey("parent"))).toBeGreaterThan(0);
        expect(
          (
            await store.deliverCompletion({
              runId: "parent",
              blockId: "second",
              waitpointId: ids[1]!,
              record: records[1],
              completion,
            })
          ).outcome
        ).toBe("terminal");
        const retained = await store.readCompletedRecords(ids, "parent");
        for (const rec of records)
          expect(retained.get(rec.id)).toEqual({ status: "COMPLETED", record: rec, completion });
      } finally {
        await redis.quit();
        await store.quit();
      }
    }
  );
});
