import { createRedisClient } from "@internal/redis";
import { containerTest, redisTest } from "@internal/testcontainers";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import {
  registrationEvidence,
  runContributionIndexKey,
  runRegistrationSourcesKey,
  runResultKey,
  waitpointKeys,
} from "./keys.js";
import { WaitpointFanoutWorker } from "./fanoutWorker.js";
import { StoreWaitpointCoordinator } from "./storeWaitpointCoordinator.js";
import { WaitpointStoreCoordinator, type WaitpointRecordInput } from "./storeCoordinator.js";

describe("completed sources before delivery", () => {
  redisTest(
    "pending absorption retains its source until registration and then releases it",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions, terminalRetentionMs: 50 });
      const redis = createRedisClient(redisOptions);
      const adapter = new StoreWaitpointCoordinator({ store });
      const id = generateWaitpointId("DATETIME");
      const now = new Date().toISOString();
      const args = {
        runId: "pending-expiry",
        blockId: "block",
        absorptionId: "operation",
        organizationId: "org",
        projectId: "project",
        waitpointIds: [id],
        client: undefined as never,
      };
      try {
        await store.createIfAbsent({
          record: {
            id,
            friendlyId: `waitpoint_${id}`,
            type: "DATETIME",
            environmentId: "env",
            projectId: "project",
            createdAt: now,
            updatedAt: now,
            completedAfter: now,
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        await adapter.absorbBlockers(args);
        await store.complete({
          waitpointId: id,
          completion: {
            completedAt: now,
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        expect(await redis.pttl(waitpointKeys(id).record)).toBe(-1);
        // Exceed terminal retention while no watcher is installed.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const retry = await adapter.absorbBlockers(args);
        expect((await adapter.registerBlockers(retry.registration)).pendingCount).toBe(0);
        expect(
          await redis.exists(runRegistrationSourcesKey(args.runId, args.blockId, args.absorptionId))
        ).toBe(0);
        await expect.poll(() => redis.exists(waitpointKeys(id).record)).toBe(0);
        // A lost phase-3 reply still replays from the retained result after source expiry.
        const recovered = await adapter.absorbBlockers(args);
        expect((await adapter.registerBlockers(recovered.registration)).pendingCount).toBe(0);
        expect((await store.readCompletedRecords([id], args.runId)).get(id)?.status).toBe(
          "COMPLETED"
        );
        await adapter.finalizeBlockers(args);
        expect(await redis.zcard(runContributionIndexKey(args.runId))).toBe(0);
      } finally {
        await redis.quit();
        await store.quit();
      }
    }
  );

  redisTest(
    "unaccepted preparation cleanup releases only its own source hold",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions, terminalRetentionMs: 50 });
      const redis = createRedisClient(redisOptions);
      const id = generateWaitpointId("DATETIME");
      const now = new Date().toISOString();
      const args = {
        runId: "prepared-expiry",
        blockId: "block",
        absorptionId: "A1",
        waitpointIds: [id],
        evidence: registrationEvidence([id]),
      };
      try {
        await store.createIfAbsent({
          record: {
            id,
            friendlyId: `waitpoint_${id}`,
            type: "DATETIME",
            environmentId: "env",
            projectId: "project",
            createdAt: now,
            updatedAt: now,
            completedAfter: now,
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        // Crash after source acquisition but before run absorption; both operations remain discoverable.
        await store.prepareRegistrationSources(args);
        await store.prepareRegistrationSources({ ...args, absorptionId: "A2" });
        await store.registerOrReport({
          waitpointId: id,
          runId: "other-parent",
          blockId: "other-block",
          createdAt: now,
        });
        await store.complete({
          waitpointId: id,
          completion: {
            completedAt: now,
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        await store.compensateAbsorption({ ...args, unacceptedEvidence: "!wrong-request" });
        expect(await redis.hget(waitpointKeys(id).record, "rh")).toBe("2");
        await store.compensateAbsorption({ ...args, unacceptedEvidence: args.evidence });
        await store.compensateAbsorption({ ...args, unacceptedEvidence: args.evidence });
        expect(await redis.hget(waitpointKeys(id).record, "rh")).toBe("1");
        const fanout = new WaitpointFanoutWorker({ coordinator: store, enabled: true });
        try {
          expect((await fanout.visit(id)).outcome).toBe("drained");
        } finally {
          await fanout.stop();
        }
        expect(await redis.pttl(waitpointKeys(id).record)).toBe(-1);
        await store.deleteContribution({ ...args, absorptionId: "A2" });
        expect(await redis.zcard(runContributionIndexKey(args.runId))).toBe(0);
        await expect.poll(() => redis.exists(waitpointKeys(id).record)).toBe(0);
      } finally {
        await redis.quit();
        await store.quit();
      }
    }
  );

  redisTest(
    "terminal cleanup releases interrupted registration sources and can be replayed",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions, terminalRetentionMs: 50 });
      const redis = createRedisClient(redisOptions);
      const adapter = new StoreWaitpointCoordinator({ store });
      const id = generateWaitpointId("DATETIME");
      const now = new Date().toISOString();
      const args = {
        runId: "terminal-source",
        blockId: "block",
        absorptionId: "operation",
        organizationId: "org",
        projectId: "project",
        waitpointIds: [id],
        client: undefined as never,
      };
      try {
        await store.createIfAbsent({
          record: {
            id,
            friendlyId: `waitpoint_${id}`,
            type: "DATETIME",
            environmentId: "env",
            projectId: "project",
            createdAt: now,
            updatedAt: now,
            completedAfter: now,
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        await adapter.absorbBlockers(args);
        await store.complete({
          waitpointId: id,
          completion: {
            completedAt: now,
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        expect(await redis.pttl(waitpointKeys(id).record)).toBe(-1);
        // A failed cross-slot release keeps its manifest for the next terminal attempt.
        const manifest = runRegistrationSourcesKey(args.runId, args.blockId, args.absorptionId);
        await redis.rename(manifest, `${manifest}:saved`);
        await redis.set(manifest, "wrong-type");
        await expect(
          store.releaseRunWatchers({ runId: args.runId, blockId: args.blockId, reason: "terminal" })
        ).rejects.toThrow();
        expect(await redis.zcard(runContributionIndexKey(args.runId))).toBe(1);
        await redis.del(manifest);
        await redis.rename(`${manifest}:saved`, manifest);
        await store.releaseRunWatchers({
          runId: args.runId,
          blockId: args.blockId,
          reason: "terminal",
        });
        await store.releaseRunWatchers({
          runId: args.runId,
          blockId: args.blockId,
          reason: "terminal",
        });
        expect(await redis.exists(manifest)).toBe(0);
        expect(await redis.zcard(runContributionIndexKey(args.runId))).toBe(0);
        await expect.poll(() => redis.exists(waitpointKeys(id).record)).toBe(0);
      } finally {
        await redis.quit();
        await store.quit();
      }
    }
  );

  containerTest(
    "absorption retains completed sources before first registration and replays after their actual expiry",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      const now = new Date().toISOString();
      try {
        for (const type of ["DATETIME", "RUN"] as const) {
          const id = generateWaitpointId(type);
          const record: WaitpointRecordInput = {
            id,
            friendlyId: `waitpoint_${id}`,
            type,
            environmentId: "env",
            projectId: "project",
            createdAt: now,
            updatedAt: now,
            completedAfter: type === "DATETIME" ? now : undefined,
            completedByTaskRunId: type === "RUN" ? "cached-child" : undefined,
            userProvidedIdempotencyKey: true,
            idempotencyKey: "shared-token",
            tags: ["retained"],
          };
          const completion = {
            completedAt: now,
            outputType: "application/json",
            outputIsError: type === "RUN",
            output: { inline: "" },
          };
          await store.createIfAbsent({ record, status: "COMPLETED", completion });
          const args = {
            client: prisma,
            runId: `parent-${type}`,
            blockId: "block",
            absorptionId: "absorption",
            organizationId: "org",
            projectId: "project",
            waitpointIds: [id],
            spanIdToComplete: "span",
            batchIndex: 4,
          };
          const adapter = new StoreWaitpointCoordinator({ store });
          const first = await adapter.absorbBlockers(args);
          if (first.registration.kind !== "store") throw new Error("Expected store continuation");
          expect(await redis.hlen(waitpointKeys(id).watchers)).toBe(0);
          // Simulate source expiry after the snapshot write but before watcher registration.
          // No receipt or watcher exists yet.
          await redis.pexpire(waitpointKeys(id).record, 1);
          await expect
            .poll(() => redis.exists(waitpointKeys(id).record), {
              timeout: 5_000,
              interval: 20,
              message: "completed source record never expired",
            })
            .toBe(0);
          expect((await store.readCompletedRecords([id], args.runId)).get(id)).toEqual({
            status: "COMPLETED",
            record,
            completion,
          });
          expect(await redis.pttl(runResultKey(args.runId))).toBe(-1);
          expect((await store.readBlockState(args.runId)).handoff).toBe("owed");
          // Test source expiry with both the original registration and recovery.
          expect((await adapter.registerBlockers(first.registration)).pendingCount).toBe(0);
          const restarted = new StoreWaitpointCoordinator({ store });
          const replay = await restarted.absorbBlockers(args);
          if (replay.registration.kind !== "store")
            throw new Error("Expected store replay continuation");
          expect(await restarted.registerBlockers(replay.registration)).toEqual({
            pendingCount: 0,
            cachedSpanCompletions: [
              {
                spanId: "span",
                spanCreatedAt: replay.registration.edges[0]!.createdAt,
                blockedRunId: args.runId,
                hasError: completion.outputIsError,
                cachedRunId: record.completedByTaskRunId,
              },
            ],
          });
          const state = await store.readBlockState(args.runId);
          expect(state.pendingIds).toEqual([]);
          expect(state.edges[0]?.completedAfter).toBe(record.completedAfter);
          await store.acknowledgeResumeHandoff({ runId: args.runId, blockId: args.blockId });
          await restarted.absorbBlockers(args);
          expect((await store.readBlockState(args.runId)).handoff).toBe("acked");
          // Remove the old result expiry when reusing results in an active cycle.
          await redis.pexpire(runResultKey(args.runId), 60_000);
          await restarted.absorbBlockers({
            ...args,
            blockId: "next",
            absorptionId: "next",
            expectedPreviousBlockId: args.blockId,
          });
          expect(await redis.pttl(runResultKey(args.runId))).toBe(-1);
          // An old operation must not change the result expiry.
          await redis.pexpire(runResultKey(args.runId), 60_000);
          const frozen = await redis.hgetall(runResultKey(args.runId));
          await expect(restarted.absorbBlockers(args)).rejects.toThrow("refused as stale");
          expect(await redis.pttl(runResultKey(args.runId))).toBeGreaterThan(0);
          expect(await redis.hgetall(runResultKey(args.runId))).toEqual(frozen);
        }
      } finally {
        await redis.quit();
        await store.quit();
      }
    }
  );

  containerTest(
    "missing source is rejected before installing an active block",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const adapter = new StoreWaitpointCoordinator({ store });
      try {
        await expect(
          adapter.absorbBlockers({
            runId: "missing-parent",
            client: prisma,
            blockId: "block",
            absorptionId: "absorption",
            projectId: "project",
            waitpointIds: [generateWaitpointId("DATETIME")],
          })
        ).rejects.toThrow("is not present in the store");
        expect((await store.readBlockState("missing-parent")).blockId).toBeUndefined();
      } finally {
        await store.quit();
      }
    }
  );
});
