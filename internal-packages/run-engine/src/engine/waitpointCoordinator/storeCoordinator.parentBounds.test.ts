import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import {
  runBlockKeys,
  runResultKey,
  runContributionIndexKey,
  contributionMember,
  runWithdrawalKey,
  runWithdrawalTargetsKey,
  waitpointKeys,
  watcherField,
} from "./keys.js";
import { registerWaitpointCommands, RUN_CLEANUP_PAGE_SIZE } from "./scripts.js";
import {
  WaitpointStoreCoordinator,
  type BlockEdge,
  type WaitpointCompletion,
  type WaitpointRecordInput,
} from "./storeCoordinator.js";

const PAGE = RUN_CLEANUP_PAGE_SIZE;
const COUNT = PAGE * 3 + 7;
const edge = (waitpointId: string, batchIndex?: number): BlockEdge => ({
  waitpointId,
  type: "RUN",
  batchIndex,
  createdAt: "2026-10-20T12:00:00.000Z",
});
const completion: WaitpointCompletion = {
  completedAt: "2026-10-20T12:00:00.000Z",
  outputType: "application/json",
  outputIsError: false,
  output: { inline: "first" },
};
const record = (id: string): WaitpointRecordInput => ({
  id,
  friendlyId: id,
  type: "RUN",
  environmentId: "env",
  projectId: "project",
  createdAt: completion.completedAt,
  updatedAt: completion.completedAt,
  userProvidedIdempotencyKey: false,
  tags: [],
});
const calls = (stats: string, command: string) =>
  Number(
    stats
      .split("\n")
      .find((line) => line.startsWith(`cmdstat_${command}:`))
      ?.split("calls=")[1]
      ?.split(",")[0] ?? 0
  );

// Cumulative blocks are assembled by many small calls, as production children do.
async function add(store: WaitpointStoreCoordinator, runId: string, count = COUNT) {
  for (let i = 0; i < count; i++)
    await store.absorbBlockers({ runId, blockId: "B1", edges: [edge(`w_${i}`)] });
}

describe("bounded cumulative parent operations", () => {
  redisTest(
    "reads hard-bounded pages and selectively clears without enumerating surviving collections",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      registerWaitpointCommands(redis);
      const runId = "large-parent",
        keys = runBlockKeys(runId);
      try {
        await add(store, runId);
        await store.absorbBlockers({ runId, blockId: "B1", edges: [edge("w_0", 1)] });
        await store.deliverCompletion({ runId, blockId: "B1", waitpointId: "w_0", completion });
        for (let i = 0; i < COUNT; i++)
          await store.deliverCompletion({
            runId,
            blockId: "B1",
            waitpointId: `early_${i}`,
            completion,
          });
        const before = await redis.info("commandstats");
        let offset = 0,
          earlyOffset = 0,
          earlyAfter = "",
          revision = "",
          cutoff = "0",
          pages = 0;
        for (let visits = 0; visits < 10; visits++) {
          const reply = await redis.runReadBlockState(
            keys.edge,
            keys.state,
            keys.edgeIndex,
            keys.doneOrder,
            keys.earlyOrder,
            pages ? "page" : "start",
            revision,
            cutoff,
            String(offset),
            earlyAfter
          );
          expect(reply[0]).toBe("page");
          revision = reply[1]!;
          cutoff = reply[2]!;
          const edgeCount = Number(reply[6]),
            earlyCount = Number(reply[7]);
          expect(edgeCount).toBeLessThanOrEqual(PAGE);
          expect(earlyCount).toBeLessThanOrEqual(PAGE);
          expect(reply).toHaveLength(8 + edgeCount * 3 + earlyCount * 2);
          offset += edgeCount;
          earlyOffset += earlyCount;
          pages++;
          if (earlyCount) earlyAfter = reply[reply.length - 1]!;
          if (edgeCount < PAGE && earlyCount < PAGE) break;
        }
        expect(pages).toBe(4);
        expect(offset).toBe(COUNT + 1);
        expect(earlyOffset).toBe(COUNT);
        const state = await store.readBlockState(runId);
        expect(state.edges).toHaveLength(COUNT + 1);
        expect(state.pendingIds).toHaveLength(COUNT - 1);
        expect(state.deliveredIds).toHaveLength(COUNT + 1);
        await store.clearBlockState({ runId, blockId: "B1", edgeIds: ["w_0#"] });
        expect((await store.readBlockState(runId)).deliveredIds).toEqual(["w_0"]);
        expect(await redis.exists(keys.early, keys.earlyOrder)).toBe(0);
        // Large selective requests are split; each atomic command touches <=128 requested edges.
        await store.clearBlockState({
          runId,
          blockId: "B1",
          edgeIds: Array.from({ length: COUNT - 1 }, (_, i) => `w_${i + 1}#`),
        });
        const remaining = await store.readBlockState(runId);
        expect(remaining.edges.map((item) => item.edgeId)).toEqual(["w_0#1"]);
        expect(remaining.deliveredIds).toEqual(["w_0"]);
        await store.clearBlockState({ runId, blockId: "B1", edgeIds: ["w_0#1"] });
        expect((await store.readBlockState(runId)).deliveredIds).toEqual([]);
        expect(await redis.hget(runResultKey(runId), "w_0")).toBe(JSON.stringify(completion));
        const after = await redis.info("commandstats");
        for (const command of ["hkeys", "hgetall", "smembers", "scan", "hscan", "sscan"])
          expect(calls(after, command)).toBe(calls(before, command));
      } finally {
        await store.quit();
        await redis.quit();
      }
    }
  );

  redisTest(
    "returns the read-start snapshot while completions land before every later page",
    async ({ redisOptions }) => {
      const writer = new WaitpointStoreCoordinator({ redisOptions });
      let pages = 0;
      const reader = new WaitpointStoreCoordinator({
        redisOptions,
        beforeCommand: async () => {
          pages++;
          if (pages === 1) return;
          // A completes after its page; B before its page. Mixing current statuses yields no snapshot.
          const start = (pages - 2) * PAGE;
          for (let i = start; i < Math.min(COUNT, start + PAGE * 2); i++)
            await writer.deliverCompletion({
              runId: "arrival",
              blockId: "B1",
              waitpointId: `w_${i}`,
              completion,
            });
          await writer.deliverCompletion({
            runId: "arrival",
            blockId: "B1",
            waitpointId: `later_${pages}`,
            completion,
          });
        },
      });
      try {
        await add(writer, "arrival");
        await writer.deliverCompletion({
          runId: "arrival",
          blockId: "B1",
          waitpointId: "w_0",
          completion,
        });
        const snapshot = await reader.readBlockState("arrival");
        expect(pages).toBe(4);
        expect(snapshot.edges).toHaveLength(COUNT);
        expect(snapshot.deliveredIds).toEqual(["w_0"]);
        expect(new Set(snapshot.pendingIds)).toEqual(
          new Set(Array.from({ length: COUNT - 1 }, (_, i) => `w_${i + 1}`))
        );
        expect(snapshot.handoff).toBe("none");
        const now = await writer.readBlockState("arrival");
        expect(now.pendingIds).toEqual([]);
        expect(now.handoff).toBe("owed");
      } finally {
        await reader.quit();
        await writer.quit();
      }
    }
  );

  redisTest(
    "restarts on structural changes, including clearing and recreating the same block identity",
    async ({ redisOptions }) => {
      const writer = new WaitpointStoreCoordinator({ redisOptions });
      let pages = 0;
      const reader = new WaitpointStoreCoordinator({
        redisOptions,
        beforeCommand: async () => {
          expect(++pages, "structural retry did not converge").toBeLessThanOrEqual(4);
          if (pages !== 2) return;
          await writer.clearBlockState({ runId: "recreated", blockId: "B1" });
          await writer.absorbBlockers({
            runId: "recreated",
            blockId: "B1",
            edges: [edge("replacement")],
          });
          await writer.deliverCompletion({
            runId: "recreated",
            blockId: "B1",
            waitpointId: "replacement",
            completion,
          });
        },
      });
      try {
        await add(writer, "recreated");
        const snapshot = await reader.readBlockState("recreated");
        expect(pages).toBe(3);
        expect(snapshot.edges.map((item) => item.waitpointId)).toEqual(["replacement"]);
        expect(snapshot.pendingIds).toEqual([]);
        expect(snapshot.deliveredIds).toEqual(["replacement"]);
        expect(snapshot.handoff).toBe("owed");
      } finally {
        await reader.quit();
        await writer.quit();
      }
    }
  );

  redisTest(
    "preserves first early receipt, empty-absorption handoff, and terminal retention of every index",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      const runId = "early",
        keys = runBlockKeys(runId);
      try {
        await store.deliverCompletion({ runId, blockId: "B1", waitpointId: "a", completion });
        const ordinal = await redis.zscore(keys.earlyOrder, "a");
        await store.deliverCompletion({
          runId,
          blockId: "B1",
          waitpointId: "a",
          completion: { ...completion, output: { inline: "duplicate" } },
        });
        expect(await redis.zscore(keys.earlyOrder, "a")).toBe(ordinal);
        await store.absorbBlockers({ runId, blockId: "B1", edges: [] });
        expect((await store.readBlockState(runId)).handoff).toBe("owed");
        const adopted = await store.absorbBlockers({
          runId,
          blockId: "B1",
          edges: [
            {
              ...edge("a"),
              reported: { completion: { ...completion, output: { inline: "reported" } } },
            },
          ],
        });
        expect(adopted.alreadyDelivered).toEqual([{ waitpointId: "a", completion }]);
        expect(await redis.zscore(keys.doneOrder, "a")).toBe(ordinal);
        expect(await redis.zscore(keys.earlyOrder, "a")).toBeNull();
        await store.deliverCompletion({
          runId,
          blockId: "B1",
          waitpointId: "unreferenced",
          completion,
        });
        await store.cleanupRunBlockState({ runId, reason: "terminal" });
        for (const key of [keys.state, keys.edgeIndex, keys.doneOrder, keys.early, keys.earlyOrder])
          expect(await redis.pttl(key)).toBeGreaterThan(0);
      } finally {
        await store.quit();
        await redis.quit();
      }
    }
  );

  redisTest(
    "a lost rollover reply remains recoverable after a newer block and stale caller retry",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      registerWaitpointCommands(redis);
      const runId = "rollover",
        keys = runBlockKeys(runId);
      try {
        await store.createIfAbsent({ record: record("shared"), status: "PENDING" });
        for (let i = 0; i < COUNT; i++)
          await store.registerBlocks({ runId, blockId: "B1", edges: [edge("shared", i)] });
        const before = await redis.info("commandstats");
        // Execute the real commit but omit its JS continuation: model lost reply/process restart.
        const rolled = await redis.runAbsorbBlockers(
          keys.pend,
          keys.done,
          keys.edge,
          keys.state,
          "wp:v1:run:{rollover}:unused",
          runResultKey(runId),
          keys.refs,
          keys.edgeIndex,
          keys.doneOrder,
          keys.early,
          keys.earlyOrder,
          runWithdrawalKey(runId, "B1"),
          runWithdrawalTargetsKey(runId, "B1"),
          runContributionIndexKey(runId),
          "B2",
          "1",
          "B1",
          "0",
          "",
          contributionMember("B2", ""),
          "lost-reply"
        );
        expect(rolled).toEqual(["absorbed", "0", "0", "B1", "0"]);
        expect(await redis.hlen(runWithdrawalTargetsKey(runId, "B1"))).toBe(COUNT);
        await store.registerBlocks({
          runId,
          blockId: "B3",
          expectedPreviousBlockId: "B2",
          edges: [edge("shared", 0)],
        });
        const stale = await store.absorbBlockers({
          runId,
          blockId: "B2",
          expectedPreviousBlockId: "B1",
          edges: [],
        });
        expect(stale.outcome).toBe("stale");
        expect(await store.readWithdrawalPage({ runId, blockId: "B1" })).toBeUndefined();
        expect(await redis.hlen(waitpointKeys("shared").watchers)).toBe(1);
        expect(
          await redis.hexists(waitpointKeys("shared").watchers, watcherField(runId, "B3", 0))
        ).toBe(1);
        expect((await store.readBlockState(runId)).blockId).toBe("B3");
        const after = await redis.info("commandstats");
        for (const command of ["hkeys", "hgetall", "smembers", "scan", "hscan", "sscan"])
          expect(calls(after, command)).toBe(calls(before, command));
      } finally {
        await store.quit();
        await redis.quit();
      }
    }
  );
});
