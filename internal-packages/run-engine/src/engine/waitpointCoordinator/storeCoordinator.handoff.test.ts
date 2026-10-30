import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import {
  runBlockKeys,
  runContributionKey,
  runContributionIndexKey,
  contributionMember,
  registrationEvidence,
} from "./keys.js";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";

describe("fanout handoff reads", () => {
  redisTest(
    "fanout handoff read is independent of blocker collections and preserves failure semantics",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      const keys = runBlockKeys("handoff-read-run");
      try {
        expect(await store.readBlockHandoff("handoff-read-run")).toBe("none");
        // These unrelated collections are intentionally unreadable. The fixed-size handoff read
        // must not touch them, regardless of their cardinality or shape.
        await redis.set(keys.pend, "wrong-type");
        await redis.set(keys.done, "wrong-type");
        await redis.set(keys.edge, "wrong-type");
        await redis.hset(keys.state, "hs", "owed");
        expect(await store.readBlockHandoff("handoff-read-run")).toBe("owed");
        await redis.hset(keys.state, "blk", "current-block");
        expect(await store.readBlockHandoff("handoff-read-run", "current-block")).toBe("owed");
        expect(await store.readBlockHandoff("handoff-read-run", "old-block")).toBe("none");
        await redis.hset(keys.state, "term", "1");
        expect(await store.readBlockHandoff("handoff-read-run", "current-block")).toBe("none");
        await redis.hdel(keys.state, "term");
        await redis.hset(keys.state, "hs", "ack");
        expect(await store.readBlockHandoff("handoff-read-run")).toBe("acked");
        await redis.hset(keys.state, "hs", "unknown");
        expect(await store.readBlockHandoff("handoff-read-run")).toBe("none");
        await redis.del(keys.state);
        await redis.set(keys.state, "wrong-type");
        await expect(store.readBlockHandoff("handoff-read-run")).rejects.toThrow("WRONGTYPE");
      } finally {
        await store.quit();
        await redis.quit();
      }
    }
  );
});

describe("contribution discovery", () => {
  redisTest(
    "an operation-free registration keeps its claim until ordinary block cleanup",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      const args = {
        runId: "shared-unowned-run",
        blockId: "B1",
        edges: [{ waitpointId: "W1", type: "RUN" as const, createdAt: new Date().toISOString() }],
      };
      try {
        await store.absorbBlockers({ ...args, absorptionId: "A1" });
        await store.absorbBlockers(args);
        await store.absorbBlockers({ ...args, absorptionId: "A2" });
        for (const absorptionId of ["A1", "A2"]) {
          await store.compensateAbsorption({ ...args, absorptionId });
          expect((await store.readBlockState(args.runId)).pendingIds).toEqual(["W1"]);
        }
        await store.clearBlockState({ runId: args.runId, blockId: args.blockId });
        expect((await store.readBlockState(args.runId)).edges).toEqual([]);
        expect(await redis.exists(runBlockKeys(args.runId).refs)).toBe(0);
      } finally {
        await redis.quit();
        await store.quit();
      }
    }
  );

  redisTest(
    "recovery requires this block's contribution and the complete logical request",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const runId = "recovery-evidence-run";
      const operation = { runId, blockId: "B1", absorptionId: "A1", waitpointIds: ["W1"] };
      const edge = (waitpointId: string, batchIndex?: number) => ({
        waitpointId,
        batchIndex,
        type: "RUN" as const,
        createdAt: new Date().toISOString(),
      });
      try {
        expect(await store.hasAbsorbedBlockers(operation)).toBe(false);
        await store.absorbBlockers({ ...operation, edges: [edge("W1")] });
        // Acceptance is scoped to the original complete request, never a superset.
        expect(await store.hasAbsorbedBlockers({ ...operation, waitpointIds: ["W1", "W2"] })).toBe(
          false
        );
        expect(await store.hasAbsorbedBlockers({ ...operation, blockId: "old" })).toBe(false);
        expect(
          await store.hasAbsorbedBlockers({ ...operation, absorptionId: "never-accepted" })
        ).toBe(false);
        await store.markRegistrationComplete({
          ...operation,
          evidence: registrationEvidence(operation.waitpointIds),
        });
        expect(await store.hasAbsorbedBlockers(operation)).toBe(true);
        await store.compensateAbsorption(operation);
        expect(await store.hasAbsorbedBlockers(operation)).toBe(true);
        expect(await store.hasAbsorbedBlockers({ ...operation, waitpointIds: ["W1", "W2"] })).toBe(
          false
        );
        expect(await store.hasAbsorbedBlockers({ ...operation, batchIndex: 0 })).toBe(false);
        await store.absorbBlockers({
          ...operation,
          absorptionId: "duplicate",
          edges: [edge("W1")],
        });
        expect(await store.readContribution({ ...operation, absorptionId: "duplicate" })).toEqual([
          "W1#",
        ]);
        expect(await store.hasAbsorbedBlockers({ ...operation, absorptionId: "duplicate" })).toBe(
          true
        );
        await store.absorbBlockers({
          ...operation,
          absorptionId: "indexed",
          edges: [edge("W1", 0)],
        });
        await store.markRegistrationComplete({
          ...operation,
          absorptionId: "indexed",
          evidence: registrationEvidence(["W1"], 0),
        });
        expect(
          await store.hasAbsorbedBlockers({ ...operation, absorptionId: "indexed", batchIndex: 0 })
        ).toBe(true);
        await store.clearBlockState({ runId, blockId: "B1" });
        expect(await store.hasAbsorbedBlockers(operation)).toBe(false);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "indexes only outstanding operations and retires them atomically without touching another generation",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      const runId = "indexed-run";
      const index = runContributionIndexKey(runId);
      const edge = (waitpointId: string) => ({
        waitpointId,
        type: "RUN" as const,
        createdAt: new Date().toISOString(),
      });
      try {
        await store.absorbBlockers({
          runId,
          blockId: "B1",
          absorptionId: "A1",
          edges: [edge("W1")],
        });
        await store.absorbBlockers({
          runId,
          blockId: "B1",
          absorptionId: "A2",
          edges: [edge("W2")],
        });
        await store.absorbBlockers({
          runId,
          blockId: "B1",
          absorptionId: "A3",
          edges: [edge("W1")],
        });
        expect(await redis.zrange(index, 0, 9)).toEqual([
          contributionMember("B1", "A1"),
          contributionMember("B1", "A2"),
          contributionMember("B1", "A3"),
        ]);
        expect(await redis.pttl(index)).toBe(-1);
        await store.deleteContribution({ runId, blockId: "B1", absorptionId: "A1" });
        expect(await redis.exists(runContributionKey(runId, "B1", "A1"))).toBe(0);
        await store.compensateAbsorption({ runId, blockId: "B1", absorptionId: "A2" });
        await store.deleteContribution({ runId, blockId: "B1", absorptionId: "A3" });
        expect(await redis.exists(index)).toBe(0);
        expect((await store.readBlockState(runId)).edges.map((e) => e.waitpointId)).toEqual(["W1"]);
        await store.absorbBlockers({
          runId,
          blockId: "B1",
          absorptionId: "old",
          edges: [edge("old")],
        });
        await store.absorbBlockers({
          runId,
          blockId: "B2",
          expectedPreviousBlockId: "B1",
          absorptionId: "new",
          edges: [edge("new")],
        });
        await store.compensateAbsorption({ runId, blockId: "B1", absorptionId: "old" });
        expect(await redis.zrange(index, 0, 9)).toEqual([contributionMember("B2", "new")]);
        expect((await store.readBlockState(runId)).edges.map((e) => e.waitpointId)).toEqual([
          "new",
        ]);
      } finally {
        await store.quit();
        await redis.quit();
      }
    }
  );
});
