import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { WaitpointFanoutWorker } from "./fanoutWorker.js";
import { idempotencyKey, registrationEvidence, waitpointKeys } from "./keys.js";
import { WaitpointStoreCoordinator, type WaitpointRecordInput } from "./storeCoordinator.js";

describe("keyedRetention", () => {
  redisTest(
    "all terminal paths retain keyed DATETIME through reservation lifetime",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions, terminalRetentionMs: 1000 });
      const redis = createRedisClient(redisOptions);
      const worker = new WaitpointFanoutWorker({ coordinator: store, enabled: false });
      const completion = {
        completedAt: new Date().toISOString(),
        outputType: "application/json",
        outputIsError: false,
        output: null,
      };
      try {
        for (const lifetime of [undefined, new Date(Date.now() + 60_000).toISOString()]) {
          for (const terminal of ["create", "no-watchers", "fanout"]) {
            const id = generateWaitpointId("DATETIME");
            const rec: WaitpointRecordInput = {
              id,
              friendlyId: `waitpoint_${id}`,
              type: "DATETIME",
              environmentId: "env",
              projectId: "project",
              createdAt: completion.completedAt,
              updatedAt: completion.completedAt,
              tags: [],
              userProvidedIdempotencyKey: true,
              idempotencyKey: id,
              idempotencyKeyExpiresAt: lifetime,
              completedAfter: completion.completedAt,
            };
            if (terminal === "create") {
              await store.createIfAbsent({ record: rec, status: "COMPLETED", completion });
              // Reservation publication uses the same deadline; this path asserts creation retention.
              if (lifetime)
                await redis.set(idempotencyKey("env", id), id, "PXAT", Date.parse(lifetime));
              else await redis.set(idempotencyKey("env", id), id);
            } else {
              await store.createWithIdempotencyKey({
                record: rec,
                environmentId: "env",
                idempotencyKey: id,
              });
              if (terminal === "fanout")
                await store.registerBlocks({
                  runId: `run_${id}`,
                  blockId: id,
                  edges: [{ waitpointId: id, createdAt: completion.completedAt, type: rec.type }],
                });
              const hold = {
                runId: `held_${id}`,
                blockId: "block",
                absorptionId: "operation",
                waitpointIds: [id],
                evidence: registrationEvidence([id]),
              };
              await store.prepareRegistrationSources(hold);
              await store.complete({ waitpointId: id, completion });
              if (terminal === "fanout") expect((await worker.visit(id)).outcome).toBe("drained");
              expect(await redis.pttl(waitpointKeys(id).record)).toBe(-1);
              if (terminal === "fanout") {
                await store.deleteContribution(hold);
                expect(await redis.pttl(waitpointKeys(id).record)).toBe(-1); // Allocation still pins it.
              }
              await store.acknowledgeIdempotencyCandidate({
                candidateId: id,
                environmentId: "env",
                idempotencyKey: id,
                acceptUntil: Date.now(),
                winnerId: id,
              });
              if (terminal === "no-watchers") {
                expect(await redis.pttl(waitpointKeys(id).record)).toBe(-1); // Registration still pins it.
                await store.deleteContribution(hold);
              }
            }
            const recordTTL = await redis.pttl(waitpointKeys(id).record);
            const keyTTL = await redis.pttl(idempotencyKey("env", id));
            if (!lifetime) expect(recordTTL).toBe(-1);
            else {
              expect(recordTTL).toBeGreaterThan(50_000);
              expect(recordTTL).toBeGreaterThanOrEqual(keyTTL);
            }
            expect(await store.readIdempotencyKey("env", id)).toBe(id);
            expect((await store.readCompletedRecords([id])).get(id)?.status).toBe("COMPLETED");
          }
        }
        const unkeyed = generateWaitpointId("DATETIME");
        await store.createIfAbsent({
          record: {
            id: unkeyed,
            friendlyId: unkeyed,
            type: "DATETIME",
            environmentId: "env",
            projectId: "project",
            createdAt: completion.completedAt,
            updatedAt: completion.completedAt,
            tags: [],
            userProvidedIdempotencyKey: false,
          },
          status: "COMPLETED",
          completion,
        });
        expect(await redis.pttl(waitpointKeys(unkeyed).record)).toBeGreaterThan(0);
        expect(await redis.pttl(waitpointKeys(unkeyed).record)).toBeLessThanOrEqual(1000);
      } finally {
        await worker.stop();
        await redis.quit();
        await store.quit();
      }
    }
  );
});
