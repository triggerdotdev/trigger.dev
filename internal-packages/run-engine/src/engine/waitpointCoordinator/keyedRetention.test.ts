import { createRedisClient } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { WaitpointFanoutWorker } from "./fanoutWorker.js";
import {
  idempotencyKey,
  registrationEvidence,
  waitpointKeys,
  waitpointRelatedRunsKey,
} from "./keys.js";
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

  redisTest(
    "keyed standalone MANUAL retains from completion whatever its key lifetime; run-bound keeps its key",
    async ({ redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const redis = createRedisClient(redisOptions);
      const worker = new WaitpointFanoutWorker({ coordinator: store, enabled: false });
      const day = 24 * 60 * 60 * 1000;
      try {
        const cases = [
          ...[undefined, 30 * day, 60 * 60 * 1000].map((lifetimeMs) => ({
            lifetimeMs,
            standalone: true,
          })),
          // Catches: retention from completion reaching a run-bound token, kept for ever as before.
          { lifetimeMs: undefined, standalone: false },
        ];
        for (const { lifetimeMs, standalone } of cases) {
          const id = generateWaitpointId("MANUAL");
          const now = new Date().toISOString();
          await store.createWithIdempotencyKey({
            record: {
              id,
              friendlyId: `waitpoint_${id}`,
              type: "MANUAL",
              environmentId: "env",
              projectId: "project",
              createdAt: now,
              updatedAt: now,
              tags: [],
              userProvidedIdempotencyKey: true,
              idempotencyKey: id,
              idempotencyKeyExpiresAt:
                lifetimeMs === undefined
                  ? undefined
                  : new Date(Date.now() + lifetimeMs).toISOString(),
              ...(standalone ? { standalone: true as const } : {}),
            },
            environmentId: "env",
            idempotencyKey: id,
          });
          await store.registerBlocks({
            runId: `run_${id}`,
            blockId: id,
            edges: [{ waitpointId: id, createdAt: now, type: "MANUAL" }],
          });
          await store.complete({
            waitpointId: id,
            completion: {
              completedAt: new Date().toISOString(),
              outputType: "application/json",
              outputIsError: false,
              output: null,
            },
          });
          expect((await worker.visit(id)).outcome).toBe("drained");
          expect(await redis.pttl(waitpointKeys(id).record)).toBe(-1); // Allocation still pins it.
          const acknowledgedAt = Date.now();
          await store.acknowledgeIdempotencyCandidate({
            candidateId: id,
            environmentId: "env",
            idempotencyKey: id,
            acceptUntil: Date.now(),
            winnerId: id,
          });
          if (!standalone) {
            expect(await redis.pttl(waitpointKeys(id).record)).toBe(-1);
            expect(await redis.pttl(idempotencyKey("env", id))).toBe(-1);
            continue;
          }
          for (const key of [waitpointKeys(id).record, waitpointRelatedRunsKey(id)]) {
            const expiresAt = Date.now() + (await redis.pttl(key));
            expect(Math.abs(expiresAt - (acknowledgedAt + 14 * day))).toBeLessThan(60_000);
          }
          const reservation = await redis.pttl(idempotencyKey("env", id));
          if (lifetimeMs === undefined) expect(reservation).toBe(-1);
          else expect(Math.abs(reservation - lifetimeMs)).toBeLessThan(60_000);
        }
      } finally {
        await worker.stop();
        await redis.quit();
        await store.quit();
      }
    }
  );
});
