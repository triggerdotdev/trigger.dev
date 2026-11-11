import { createRedisClient, type RedisCommander } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import {
  candidateMintFenceKey,
  idempotencyKey,
  idempotencyClaimKey,
  idempotencyReceiptKey,
  waitpointKeys,
} from "./keys.js";
import { registerWaitpointCommands } from "./scripts.js";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";

describe("keyedCandidateRecovery", () => {
  redisTest(
    "key expiry and replacement cannot turn a published winner into a loser on replay",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      registerWaitpointCommands(redis);
      const firstId = generateWaitpointId("DATETIME");
      const secondId = generateWaitpointId("DATETIME");
      const acceptUntil = Date.now() + 300_000;
      const input = (id: string) => ({
        record: {
          id,
          type: "DATETIME" as const,
          projectId: "p",
          environmentId: "e",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          friendlyId: `waitpoint_${id}`,
          tags: [],
          userProvidedIdempotencyKey: true,
          completedAfter: new Date().toISOString(),
        },
        environmentId: "e",
        idempotencyKey: "k",
        acceptUntil,
      });
      try {
        await store.createWithIdempotencyKey(input(firstId));
        await redis.del(idempotencyKey("e", "k"));
        await store.createWithIdempotencyKey(input(secondId));
        expect(await store.createWithIdempotencyKey(input(firstId))).toEqual({
          waitpointId: firstId,
          created: false,
        });
        expect(
          await store.recoverIdempotencyCandidate({
            candidateId: firstId,
            environmentId: "e",
            idempotencyKey: "k",
            acceptUntil,
          })
        ).toEqual({ winnerId: firstId });
        expect(await redis.exists(waitpointKeys(firstId).record)).toBe(1);
        expect(await redis.get(idempotencyKey("e", "k"))).toBe(secondId);
        expect(await redis.pttl(idempotencyReceiptKey("e", "k", firstId))).toBe(-1);
        await store.complete({
          waitpointId: firstId,
          completion: {
            completedAt: new Date().toISOString(),
            outputType: "application/json",
            outputIsError: false,
            output: null,
          },
        });
        await store.acknowledgeIdempotencyCandidate({
          candidateId: firstId,
          environmentId: "e",
          idempotencyKey: "k",
          acceptUntil,
          winnerId: firstId,
        });
        expect(await redis.pttl(idempotencyReceiptKey("e", "k", firstId))).toBeGreaterThan(0);
        expect(await store.createWithIdempotencyKey(input(firstId))).toEqual({
          waitpointId: firstId,
          created: false,
        });
        expect(
          await store.recoverIdempotencyCandidate({
            candidateId: firstId,
            environmentId: "e",
            idempotencyKey: "k",
            acceptUntil,
          })
        ).toEqual({ winnerId: firstId, completed: true });
        expect(await redis.exists(waitpointKeys(firstId).record)).toBe(1);
      } finally {
        redis.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "recovery seals an unpublished crash orphan and fences delayed foreground creation",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      registerWaitpointCommands(redis);
      const candidateId = generateWaitpointId("DATETIME");
      // Expired on both the host and Redis clocks, without assuming millisecond clock agreement.
      const acceptUntil = 1;
      const record = {
        id: candidateId,
        type: "DATETIME" as const,
        projectId: "p",
        environmentId: "e",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        friendlyId: `waitpoint_${candidateId}`,
        tags: [],
        userProvidedIdempotencyKey: true,
      };
      try {
        // Exact durable state after candidate create, before reservation publication.
        await redis.set(idempotencyReceiptKey("e", "k", candidateId), "pending");
        await store.createIfAbsent({ record, status: "PENDING" });
        expect(
          await store.recoverIdempotencyCandidate({
            candidateId,
            environmentId: "e",
            idempotencyKey: "k",
            acceptUntil,
          })
        ).toEqual({ winnerId: undefined });
        expect(await redis.exists(waitpointKeys(candidateId).record)).toBe(0);
        await expect(
          store.createWithIdempotencyKey({
            record,
            environmentId: "e",
            idempotencyKey: "k",
            acceptUntil,
          })
        ).rejects.toThrow("closed");
        expect(await redis.exists(idempotencyKey("e", "k"))).toBe(0);
        // The fixed deadline continues to fence after the bounded local tombstone ages out.
        await redis.del(
          candidateMintFenceKey(candidateId),
          idempotencyReceiptKey("e", "k", candidateId)
        );
        await expect(
          store.createWithIdempotencyKey({
            record,
            environmentId: "e",
            idempotencyKey: "k",
            acceptUntil,
          })
        ).rejects.toThrow("closed");
        expect(await redis.exists(waitpointKeys(candidateId).record)).toBe(0);
      } finally {
        redis.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "recovery refuses an authorized pending candidate and foreground publication still succeeds",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      const recovery = new WaitpointStoreCoordinator({ redisOptions });
      const candidateId = generateWaitpointId("DATETIME");
      const acceptUntil = Date.now() + 300_000;
      const record = {
        id: candidateId,
        friendlyId: `waitpoint_${candidateId}`,
        type: "DATETIME" as const,
        projectId: "p",
        environmentId: "e",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: [],
        userProvidedIdempotencyKey: true,
      };
      try {
        // Durable state immediately before reservation publication, established by real operations.
        await redis.set(idempotencyReceiptKey("e", "k", candidateId), "pending");
        await store.createIfAbsent({ record, status: "PENDING" });
        await expect(
          recovery.recoverIdempotencyCandidate({
            candidateId,
            environmentId: "e",
            idempotencyKey: "k",
            acceptUntil,
          })
        ).rejects.toThrow("still authorized");
        expect(
          await store.createWithIdempotencyKey({
            record,
            environmentId: "e",
            idempotencyKey: "k",
            acceptUntil,
          })
        ).toEqual({ waitpointId: candidateId, created: true });
        expect(
          await recovery.recoverIdempotencyCandidate({
            candidateId,
            environmentId: "e",
            idempotencyKey: "k",
            acceptUntil,
          })
        ).toEqual({ winnerId: candidateId });
      } finally {
        await redis.quit();
        await Promise.all([store.quit(), recovery.quit()]);
      }
    }
  );

  redisTest(
    "a losing receipt survives key expiry and retry completes loser cleanup",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      registerWaitpointCommands(redis);
      const winnerId = generateWaitpointId("DATETIME");
      const candidateId = generateWaitpointId("DATETIME");
      const acceptUntil = Date.now() + 300_000;
      const record = {
        id: candidateId,
        friendlyId: `waitpoint_${candidateId}`,
        type: "DATETIME" as const,
        projectId: "p",
        environmentId: "e",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: [],
        userProvidedIdempotencyKey: true,
      };
      try {
        await store.createIfAbsent({ record, status: "PENDING" });
        await redis.set(idempotencyKey("e", "k"), winnerId);
        // Crash boundary: atomic reservation returned a loser, process died before discard.
        await (redis as typeof redis & Pick<RedisCommander, "wpIdemReceipt">).wpIdemReceipt(
          idempotencyKey("e", "k"),
          idempotencyReceiptKey("e", "k", candidateId),
          idempotencyClaimKey("e", "k"),
          candidateId,
          "",
          String(acceptUntil),
          "reserve",
          ""
        );
        await redis.del(idempotencyKey("e", "k"));
        expect(
          await store.recoverIdempotencyCandidate({
            candidateId,
            environmentId: "e",
            idempotencyKey: "k",
            acceptUntil,
          })
        ).toEqual({ winnerId });
        expect(await redis.exists(waitpointKeys(candidateId).record)).toBe(0);
        await expect(
          store.createWithIdempotencyKey({
            record,
            environmentId: "e",
            idempotencyKey: "k",
            acceptUntil,
          })
        ).resolves.toEqual({ waitpointId: winnerId, created: false });
        expect(await redis.exists(waitpointKeys(candidateId).record)).toBe(0);
        expect(await redis.exists(idempotencyKey("e", "k"))).toBe(0);
      } finally {
        redis.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "successor generation fences late publication and resent begin without changing a winner",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      registerWaitpointCommands(redis);
      const candidateId = generateWaitpointId("DATETIME");
      const successorId = generateWaitpointId("DATETIME");
      const acceptUntil = Date.now() + 300_000;
      const record = (id: string) => ({
        id,
        friendlyId: `waitpoint_${id}`,
        type: "DATETIME" as const,
        environmentId: "e",
        projectId: "p",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: [],
        userProvidedIdempotencyKey: true,
      });
      try {
        await store.beginIdempotencyKeyClaim({
          environmentId: "e",
          idempotencyKey: "k",
          token: "a",
          acceptUntil,
        });
        await store.beginIdempotencyKeyClaim({
          environmentId: "e",
          idempotencyKey: "k",
          token: "b",
          acceptUntil,
        });
        expect(
          await (redis as typeof redis & Pick<RedisCommander, "wpBeginIdemClaim">).wpBeginIdemClaim(
            idempotencyKey("e", "k"),
            idempotencyClaimKey("e", "k"),
            "a",
            "",
            String(acceptUntil)
          )
        ).toEqual(["stale", ""]);
        await expect(
          store.createWithIdempotencyKey({
            record: record(candidateId),
            environmentId: "e",
            idempotencyKey: "k",
            claimToken: "a",
            acceptUntil,
          })
        ).rejects.toThrow("closed");
        expect(await store.probeWaitpointPresence(candidateId)).toBe("absent");
        await store.createWithIdempotencyKey({
          record: record(successorId),
          environmentId: "e",
          idempotencyKey: "k",
          claimToken: "b",
          acceptUntil,
        });
        expect(
          await store.beginIdempotencyKeyClaim({
            environmentId: "e",
            idempotencyKey: "k",
            token: "c",
            acceptUntil,
          })
        ).toEqual({ winnerId: successorId });
        expect(await redis.get(idempotencyClaimKey("e", "k"))).toBe("b");
        expect(await redis.pttl(idempotencyClaimKey("e", "k"))).toBeGreaterThan(290_000);
      } finally {
        redis.disconnect();
        await store.quit();
      }
    }
  );
});
