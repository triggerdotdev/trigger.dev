import { createHash } from "node:crypto";
import { SimpleQueue } from "@trigger.dev/redis-worker";
import { workerCatalog } from "../workerCatalog.js";
import { cycleAnchorSnapshotId } from "../systems/waitpointSystem.js";
import { keyedWaitpointTest as containerTest } from "./utils/keyedWaitpointTest.js";
import { PostgresRunStore, RedisSnapshotStore, batchStoreWaitpointId } from "@internal/run-store";
import { createRedisClient } from "@internal/redis";
import { ManualWaitpointRollbackRecovery } from "../waitpointCoordinator/manualRollbackRecovery.js";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import {
  idempotencyReceiptKey,
  organizationSourceReceiptKey,
  fanoutPartition,
  organizationPendingSourceIndexKey,
  waitpointKeys,
} from "../waitpointCoordinator/keys.js";
import { RunId, parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { timeoutError } from "@trigger.dev/core/v3";
import { describe, expect } from "vitest";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { manualWaitpointCatalogManifestKey } from "../waitpointCoordinator/manualWaitpointCatalog.js";
import { deriveBatchWaitpointId } from "../waitpointCoordinator/runWaitpointId.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import {
  makeEngine,
  triggerRun,
  dequeueAndStart,
} from "./utils/storeRunWaitpointLifecycleFixtures.js";
import { generateScopedHttpCallbackHash } from "../../../../../apps/webapp/app/services/httpCallbackHash.server.js";
import { resolveScopedWaitpointCallback } from "../../../../../apps/webapp/app/services/scopedWaitpointCallback.server.js";

describe("native batch and run-bound manual lifecycle", () => {
  containerTest(
    "queued untimed MANUAL allocation retires while its source stays pending",
    async ({ prisma, redisOptions }) => {
      const snapshots = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60000 });
      const store = new WaitpointStoreCoordinator({ redisOptions, terminalRetentionMs: 1000 });
      let enabled = true;
      const engine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore: snapshots,
        workerDisabled: true,
        isWaitpointStoreEnabled: () => enabled,
      });
      const redis = createRedisClient(redisOptions);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["manual-allocation"]);
        const run = await triggerRun(engine, env, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "manual-allocation",
        });
        for (const permanent of [false, true]) {
          enabled = true;
          const token = await engine.createManualWaitpoint({
            runId: run.id,
            environmentId: env.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
            idempotencyKey: `allocation-${permanent}`,
            ...(permanent ? {} : { idempotencyKeyExpiresAt: new Date(Date.now() + 1000) }),
          });
          const job = await engine["worker"].getJob(
            `recoverDateTimeWaitpoint:${token.waitpoint.id}`
          );
          const payload = workerCatalog.recoverDateTimeWaitpoint.schema.parse(job!.item);
          expect(payload.keyedCreation).toBeDefined();
          await expect
            .poll(() => Date.now() > payload.keyedCreation!.acceptUntil, {
              timeout: 6000,
              interval: 30,
              message: "publication fence never closed",
            })
            .toBe(true);
          const receipt = idempotencyReceiptKey(
            payload.keyedCreation!.scope,
            payload.keyedCreation!.idempotencyKey,
            payload.waitpointId
          );
          const index = organizationPendingSourceIndexKey(
            env.organization.id,
            fanoutPartition(payload.waitpointId)
          );
          const metadata = organizationSourceReceiptKey(
            env.organization.id,
            fanoutPartition(payload.waitpointId)
          );
          // Replay also repairs the premature terminal receipt left by an older recovery attempt.
          if (permanent) await redis.set(receipt, `completed:${payload.waitpointId}`);
          await engine.waitpointSystem.recoverDateTimeWaitpoint(payload);
          expect(await redis.hget(waitpointKeys(payload.waitpointId).record, "status")).toBe(
            "PENDING"
          );
          expect(await redis.hget(waitpointKeys(payload.waitpointId).record, "ka")).toBeNull();
          expect(await redis.pttl(receipt)).toBeGreaterThan(0);
          expect(await redis.hget(metadata, payload.waitpointId)).toBeNull();
          expect(await redis.zscore(index, payload.waitpointId)).not.toBeNull();
          await expect
            .poll(() => redis.exists(receipt), {
              timeout: 2000,
              interval: 20,
              message: "allocation receipt never expired",
            })
            .toBe(0);
          await engine.waitpointSystem.recoverDateTimeWaitpoint(payload);
          expect(await redis.zscore(index, payload.waitpointId)).not.toBeNull();
          await engine.completeWaitpoint({
            id: payload.waitpointId,
            organizationId: env.organization.id,
            onlyIfPending: true,
            output: { value: "accepted", isError: false },
          });
          const fanout = await engine["worker"].getJob(
            `deliverWaitpointFanout:${payload.waitpointId}`
          );
          await engine["worker"]["jobs"].deliverWaitpointFanout({
            id: `deliverWaitpointFanout:${payload.waitpointId}`,
            payload: workerCatalog.deliverWaitpointFanout.schema.parse(fanout!.item),
            deduplicationKey: undefined,
          });
          expect(await redis.zscore(index, payload.waitpointId)).not.toBeNull();
          expect(
            await store.manualCatalog.getManifest(env.organization.id, payload.waitpointId)
          ).toBeDefined();
          const maintenanceId = `retireManualWaitpointCatalog:${payload.waitpointId}`;
          const maintenance = await engine["worker"].getJob(maintenanceId);
          await engine["worker"]["jobs"].retireManualWaitpointCatalog({
            id: maintenanceId,
            payload: workerCatalog.retireManualWaitpointCatalog.schema.parse(maintenance!.item),
            deduplicationKey: maintenance!.deduplicationKey,
          });
          if (permanent)
            expect(await redis.pttl(waitpointKeys(payload.waitpointId).record)).toBe(-1);
          else
            expect(await redis.pttl(waitpointKeys(payload.waitpointId).record)).toBeGreaterThan(0);
          if (!permanent) {
            await prisma.organization.update({
              where: { id: env.organization.id },
              data: { featureFlags: { waitpointStoreEnabled: false } },
            });
            const deps = {
              target: "catalog-rollback",
              controlPlane: prisma,
              runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
              redis,
              store,
            };
            const noScheduler = new ManualWaitpointRollbackRecovery(deps);
            const inspected = await noScheduler.discover({
              organizationId: env.organization.id,
              kind: "pending-sources",
              partition: fanoutPartition(payload.waitpointId),
            });
            const rejected = await noScheduler.apply(inspected.plan, [], true, [
              payload.waitpointId,
            ]);
            expect(rejected.errors[0]?.error).toContain("workerQueue scheduler");
            const withScheduler = new ManualWaitpointRollbackRecovery({
              ...deps,
              catalogMaintenance: {
                schedule: async (item, availableAt) =>
                  engine["worker"].enqueue({
                    id: maintenanceId,
                    job: "retireManualWaitpointCatalog",
                    payload: item,
                    availableAt,
                  }),
                scheduledAt: async (item) => {
                  const scheduled = await engine["worker"].getJob(
                    `retireManualWaitpointCatalog:${item.waitpointId}`
                  );
                  return scheduled?.job === "retireManualWaitpointCatalog" &&
                    scheduled.item.waitpointId === item.waitpointId &&
                    scheduled.item.organizationId === item.organizationId &&
                    scheduled.timestamp.getTime() > Date.now()
                    ? scheduled.timestamp
                    : undefined;
                },
              },
            });
            const applied = await withScheduler.apply(inspected.plan, [], true, [
              payload.waitpointId,
            ]);
            expect(applied.errors).toEqual([]);
            expect(applied.sources[0]).toMatchObject({
              verified: true,
              catalogRetention: "finite",
            });
            expect(applied.sources[0].maintenanceAvailableAt).toBeDefined();
            // A disabled ordinary callback is allowed to ACK. Catalog ownership must survive it.
            enabled = false;
            const consumed = await engine["worker"].getJob(maintenanceId);
            await engine["worker"]["jobs"].retireManualWaitpointCatalog({
              id: maintenanceId,
              payload: workerCatalog.retireManualWaitpointCatalog.schema.parse(consumed!.item),
              deduplicationKey: consumed!.deduplicationKey,
            });
            await engine["worker"].queue.ack(maintenanceId, consumed!.deduplicationKey);
            expect((await withScheduler.verify(inspected.plan)).sources[0].verified).toBe(false);
          }
          if (!permanent)
            await expect
              .poll(() => redis.exists(waitpointKeys(payload.waitpointId).record), {
                timeout: 2000,
                interval: 20,
                message: "finite completed token never retired",
              })
              .toBe(0);
          if (!permanent) {
            const recovery = new ManualWaitpointRollbackRecovery({
              target: "catalog-rollback",
              controlPlane: prisma,
              runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
              redis,
              store,
            });
            const { plan } = await recovery.discover({
              organizationId: env.organization.id,
              kind: "pending-sources",
              partition: fanoutPartition(payload.waitpointId),
            });
            expect(
              plan.sources.some(
                (source) => source.waitpointId === payload.waitpointId && source.catalogMetadata
              )
            ).toBe(true);
            const applied = await recovery.apply(plan, [], true, [payload.waitpointId]);
            expect(applied.errors).toEqual([]);
            expect(applied.sources[0]?.verified).toBe(true);
          }
          await engine.waitpointSystem.recoverDateTimeWaitpoint(payload);
          const retirement = await engine["worker"].getJob(maintenanceId);
          if (retirement)
            await engine["worker"]["jobs"].retireManualWaitpointCatalog({
              id: maintenanceId,
              payload: workerCatalog.retireManualWaitpointCatalog.schema.parse(retirement.item),
              deduplicationKey: retirement.deduplicationKey,
            });
          expect(await redis.zscore(index, payload.waitpointId)).toBe(permanent ? "0" : null);
          if (permanent)
            expect(
              await store.manualCatalog.getManifest(env.organization.id, payload.waitpointId)
            ).toBeDefined();
          else
            expect(
              await store.manualCatalog.getManifest(env.organization.id, payload.waitpointId)
            ).toBeUndefined();
        }
      } finally {
        await engine.quit();
        await store.quit();
        await snapshots.quit();
        await redis.quit();
      }
    }
  );
  containerTest(
    "rollback discovers new source types and preserves permanent MANUAL key retention",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const adapter = new StoreWaitpointCoordinator({ store });
      const queue = new SimpleQueue({
        name: "run-engine-worker",
        schema: { retireManualWaitpointCatalog: workerCatalog.retireManualWaitpointCatalog.schema },
        redisOptions: { ...redisOptions, keyPrefix: "catalog-tool:worker:" },
      });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const manual = await adapter.createManualWaitpoint({
          runId: RunId.generate().id,
          environmentId: env.id,
          projectId: env.project.id,
          idempotencyKey: "permanent",
          mintContext: { organizationId: env.organization.id },
        });
        await adapter.complete({
          waitpointId: manual.waitpoint.id,
          organizationId: env.organization.id,
          onlyIfPending: true,
          output: { value: "accepted", isError: false },
        });
        const pending = await adapter.createManualWaitpoint({
          runId: RunId.generate().id,
          environmentId: env.id,
          projectId: env.project.id,
          mintContext: { organizationId: env.organization.id },
        });
        const elapsedAt = new Date(Date.now() - 1000);
        const elapsed = await adapter.createManualWaitpoint({
          runId: RunId.generate().id,
          environmentId: env.id,
          projectId: env.project.id,
          timeout: elapsedAt,
          mintContext: { organizationId: env.organization.id },
        });
        const batch = await prisma.batchTaskRun.create({
          data: {
            friendlyId: "batch_rollback",
            runtimeEnvironmentId: env.id,
            runCount: 0,
            status: "ABORTED",
          },
        });
        const header = await adapter.createBatchWaitpoint({
          batchId: batch.id,
          environmentId: env.id,
          projectId: env.project.id,
          mintContext: { organizationId: env.organization.id },
        });
        const recovery = new ManualWaitpointRollbackRecovery({
          catalogMaintenance: {
            schedule: async (payload, availableAt) =>
              queue.enqueue({
                id: `retireManualWaitpointCatalog:${payload.waitpointId}`,
                job: "retireManualWaitpointCatalog",
                item: payload,
                availableAt,
                visibilityTimeoutMs: 30000,
              }),
            scheduledAt: async (payload) => {
              const job = await queue.getJob(`retireManualWaitpointCatalog:${payload.waitpointId}`);
              return job?.job === "retireManualWaitpointCatalog" &&
                job.item.waitpointId === payload.waitpointId &&
                job.item.organizationId === payload.organizationId &&
                job.timestamp.getTime() > Date.now()
                ? job.timestamp
                : undefined;
            },
          },
          target: "isolated-test",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        for (const id of [
          manual.waitpoint.id,
          pending.waitpoint.id,
          elapsed.waitpoint.id,
          header.waitpoint.id,
        ]) {
          const { plan } = await recovery.discover({
            organizationId: env.organization.id,
            kind: "pending-sources",
            partition: fanoutPartition(id),
          });
          expect(plan.sources.map((source) => source.waitpointId)).toContain(id);
          const result = await recovery.apply(plan, [], true, [id]);
          expect(result.errors).toEqual([]);
          expect(result.sources.find((source) => source.waitpointId === id)?.verified).toBe(true);
          expect(
            await redis.zscore(
              organizationPendingSourceIndexKey(env.organization.id, fanoutPartition(id)),
              id
            )
          ).toBe(id !== header.waitpoint.id ? "0" : null);
        }
        const completedCatalog = await store.manualCatalog.list({
          organizationId: env.organization.id,
          environmentId: env.id,
          statuses: ["COMPLETED"],
          direction: "forward",
          limit: 10,
        });
        expect(completedCatalog.map((item) => item.record.id)).toEqual(
          expect.arrayContaining([manual.waitpoint.id, elapsed.waitpoint.id])
        );
        // Catches: rollback completing an elapsed timed MANUAL with success/null instead of
        // ordinary expiry's timeout error.
        expect(
          (await store.readCompletedRecords([elapsed.waitpoint.id])).get(elapsed.waitpoint.id)
            ?.completion
        ).toMatchObject({
          outputType: "application/json",
          outputIsError: true,
          output: { inline: JSON.stringify(timeoutError(elapsedAt)) },
        });
        const completedIds = async (outputIsError: boolean) =>
          (
            await store.manualCatalog.list({
              organizationId: env.organization.id,
              environmentId: env.id,
              statuses: ["COMPLETED"],
              outputIsError,
              direction: "forward",
              limit: 10,
            })
          ).map((item) => item.record.id);
        expect(await completedIds(true)).toContain(elapsed.waitpoint.id);
        expect(await completedIds(false)).not.toContain(elapsed.waitpoint.id);
        expect(
          (
            await store.manualCatalog.list({
              organizationId: env.organization.id,
              environmentId: env.id,
              statuses: ["PENDING"],
              direction: "forward",
              limit: 10,
            })
          ).map((item) => item.record.id)
        ).toEqual([pending.waitpoint.id]);
        expect(await redis.hget(waitpointKeys(pending.waitpoint.id).record, "status")).toBe(
          "PENDING"
        );
        expect(await redis.pttl(waitpointKeys(pending.waitpoint.id).record)).toBe(-1);
        expect(await redis.pttl(waitpointKeys(manual.waitpoint.id).record)).toBe(-1);
        expect(
          (await store.readCompletedRecords([manual.waitpoint.id])).get(manual.waitpoint.id)
            ?.completion?.output
        ).toEqual({ inline: "accepted" });
        expect(await redis.pttl(waitpointKeys(header.waitpoint.id).record)).toBeGreaterThan(0);
      } finally {
        await queue.close();
        await store.quit();
        await redis.quit();
      }
    }
  );
  // Catches: rollback completing a not-yet-due timed MANUAL with a future-dated timeout error.
  containerTest(
    "rollback keeps success for a future MANUAL deadline seen without a catalog manifest",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const adapter = new StoreWaitpointCoordinator({ store });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const { waitpoint } = await adapter.createManualWaitpoint({
          runId: RunId.generate().id,
          environmentId: env.id,
          projectId: env.project.id,
          timeout: new Date(Date.now() + 3600000),
          mintContext: { organizationId: env.organization.id },
        });
        const id = waitpoint.id;
        // Fault injection: a lost manifest sends a pending MANUAL without finite TTL to "datetime".
        await redis.hdel(manualWaitpointCatalogManifestKey(env.organization.id, id), id);
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "isolated-test",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        const { plan } = await recovery.discover({
          organizationId: env.organization.id,
          kind: "pending-sources",
          partition: fanoutPartition(id),
        });
        const source = plan.sources.find((source) => source.waitpointId === id);
        expect(source).toMatchObject({ status: "PENDING", pendingRegistryOwned: true });
        expect(source?.catalogMetadata).toBeUndefined();
        expect(await redis.pttl(waitpointKeys(id).record)).toBe(-1);
        const result = await recovery.apply(plan, [], true, [id]);
        expect(result.errors).toEqual([]);
        expect(result.sources.find((source) => source.waitpointId === id)?.verified).toBe(true);
        expect(await redis.hget(waitpointKeys(id).record, "status")).toBe("COMPLETED");
        expect((await store.readCompletedRecords([id])).get(id)?.completion).toMatchObject({
          outputIsError: false,
          output: null,
        });
      } finally {
        await store.quit();
        await redis.quit();
      }
    }
  );
  // Catches: rollback arming a finite TTL on a native MANUAL source that an unselected parent's prepared registration still holds (rh > 0).
  containerTest(
    "rollback arms no retention on held native MANUAL sources until the parent releases them",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const adapter = new StoreWaitpointCoordinator({ store });
      const queue = new SimpleQueue({
        name: "run-engine-worker",
        schema: { retireManualWaitpointCatalog: workerCatalog.retireManualWaitpointCatalog.schema },
        redisOptions: { ...redisOptions, keyPrefix: "catalog-tool:worker:" },
      });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const completed = await adapter.createManualWaitpoint({
          runId: RunId.generate().id,
          environmentId: env.id,
          projectId: env.project.id,
          mintContext: { organizationId: env.organization.id },
        });
        await adapter.complete({
          waitpointId: completed.waitpoint.id,
          organizationId: env.organization.id,
          onlyIfPending: true,
          output: { value: "accepted", isError: false },
        });
        expect(await redis.pttl(waitpointKeys(completed.waitpoint.id).record)).toBeGreaterThan(0);
        const elapsed = await adapter.createManualWaitpoint({
          runId: RunId.generate().id,
          environmentId: env.id,
          projectId: env.project.id,
          timeout: new Date(Date.now() - 1000),
          mintContext: { organizationId: env.organization.id },
        });
        // The parent prepared its registration (rh=1, PERSIST) but has not absorbed. It is never selected.
        const parent = { runId: "unselected-parent", blockId: "B1", absorptionId: "A1" };
        const ids = [completed.waitpoint.id, elapsed.waitpoint.id];
        await store.prepareRegistrationSources({
          ...parent,
          waitpointIds: ids,
          evidence: "!request:held",
        });
        const recovery = new ManualWaitpointRollbackRecovery({
          catalogMaintenance: {
            schedule: async (payload, availableAt) =>
              queue.enqueue({
                id: `retireManualWaitpointCatalog:${payload.waitpointId}`,
                job: "retireManualWaitpointCatalog",
                item: payload,
                availableAt,
                visibilityTimeoutMs: 30000,
              }),
            scheduledAt: async (payload) => {
              const job = await queue.getJob(`retireManualWaitpointCatalog:${payload.waitpointId}`);
              return job?.job === "retireManualWaitpointCatalog" &&
                job.item.waitpointId === payload.waitpointId &&
                job.item.organizationId === payload.organizationId &&
                job.timestamp.getTime() > Date.now()
                ? job.timestamp
                : undefined;
            },
          },
          target: "isolated-test",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        const plans = [];
        for (const id of ids) {
          const record = waitpointKeys(id).record;
          expect(await redis.hget(record, "rh")).toBe("1");
          expect(await redis.hlen(waitpointKeys(id).watchers)).toBe(0);
          const { plan } = await recovery.discover({
            organizationId: env.organization.id,
            kind: "pending-sources",
            partition: fanoutPartition(id),
          });
          plans.push(plan);
          const result = await recovery.apply(plan, [], true, [id]);
          expect(result.errors).toEqual([]);
          expect(result.sources.find((source) => source.waitpointId === id)).toMatchObject({
            verified: false,
            registrationHold: true,
          });
          expect(await redis.pttl(record)).toBe(-1);
          expect(await redis.hget(record, "rh")).toBe("1");
          expect(await redis.hget(record, "status")).toBe("COMPLETED");
          expect(await store.manualCatalog.getManifest(env.organization.id, id)).toBeTruthy();
          // Rollback scheduled this catalog job before RETIRE_SOURCE. With the store flag off (as
          // here) the worker consumes it without rescheduling (engine/index.ts flag gate); with the
          // flag on, retireManualCatalog reschedules it while rh > 0, as this direct call shows.
          expect(await queue.getJob(`retireManualWaitpointCatalog:${id}`)).toBeDefined();
          expect(await store.retireManualCatalog(id, env.organization.id)).toBeGreaterThan(
            Date.now()
          );
          expect(await redis.pttl(record)).toBe(-1);
          expect(await store.manualCatalog.getManifest(env.organization.id, id)).toBeTruthy();
        }
        const held = await store.readCompletedRecords(ids);
        expect(held.get(completed.waitpoint.id)?.completion?.output).toEqual({
          inline: "accepted",
        });
        expect(held.get(elapsed.waitpoint.id)?.status).toBe("COMPLETED");

        await store.releaseRegistrationSources(parent);
        for (const [i, id] of ids.entries()) {
          expect(await redis.pttl(waitpointKeys(id).record)).toBeGreaterThan(0);
          const rerun = await recovery.apply(plans[i]!, [], true, [id]);
          expect(rerun.errors).toEqual([]);
          expect(rerun.sources.find((source) => source.waitpointId === id)?.verified).toBe(true);
        }
      } finally {
        await queue.close();
        await store.quit();
        await redis.quit();
      }
    }
  );
  // Catches: a held keyed pending MANUAL verifying as intentionally retained, so its hold goes unreported.
  containerTest(
    "rollback reports the registration hold on a held keyed pending MANUAL and keeps it intact",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const adapter = new StoreWaitpointCoordinator({ store });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const { waitpoint } = await adapter.createManualWaitpoint({
          runId: RunId.generate().id,
          environmentId: env.id,
          projectId: env.project.id,
          idempotencyKey: "held-key",
          idempotencyKeyExpiresAt: new Date(Date.now() + 3600000),
          mintContext: { organizationId: env.organization.id },
        });
        const id = waitpoint.id;
        const record = waitpointKeys(id).record;
        const parent = { runId: "unselected-parent", blockId: "B1", absorptionId: "A1" };
        await store.prepareRegistrationSources({
          ...parent,
          waitpointIds: [id],
          evidence: "!request:held",
        });
        expect(await redis.hget(record, "rh")).toBe("1");
        expect(await redis.hget(record, "ka")).toBe("1");
        expect(await redis.hget(record, "status")).toBe("PENDING");
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "isolated-test",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        const { plan } = await recovery.discover({
          organizationId: env.organization.id,
          kind: "pending-sources",
          partition: fanoutPartition(id),
        });
        const source = plan.sources.find((source) => source.waitpointId === id);
        expect(source?.catalogMetadata).toBeDefined();
        expect(source?.receiptMetadata).toBeDefined();
        const before = await redis.hget(record, "r");

        const result = await recovery.apply(plan, [], true, [id]);
        const held = {
          verified: false,
          registrationHold: true,
          disposition: expect.stringContaining("registration hold remains"),
        };
        expect(result.errors).toEqual([]);
        expect(result.sources.find((source) => source.waitpointId === id)).toMatchObject(held);
        expect((await recovery.verify(plan)).sources[0]).toMatchObject(held);
        expect(await redis.pttl(record)).toBe(-1);
        expect(await redis.hget(record, "rh")).toBe("1");
        expect(await redis.hget(record, "ka")).toBe("1");
        expect(await redis.hget(record, "status")).toBe("PENDING");
        expect(await redis.hget(record, "r")).toBe(before);
        expect(await store.manualCatalog.getManifest(env.organization.id, id)).toBeTruthy();

        await store.releaseRegistrationSources(parent);
        expect(await redis.hget(record, "rh")).toBeNull();
        const rerun = await recovery.apply(plan, [], true, [id]);
        expect(rerun.errors).toEqual([]);
        expect(rerun.sources.find((source) => source.waitpointId === id)?.verified).toBe(true);
      } finally {
        await store.quit();
        await redis.quit();
      }
    }
  );
  // Catches: a held unkeyed pending MANUAL (no receipt) verifying as intentionally retained, so its hold goes unreported.
  containerTest(
    "rollback reports the registration hold on a held unkeyed pending MANUAL and keeps it intact",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const adapter = new StoreWaitpointCoordinator({ store });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const { waitpoint } = await adapter.createManualWaitpoint({
          runId: RunId.generate().id,
          environmentId: env.id,
          projectId: env.project.id,
          mintContext: { organizationId: env.organization.id },
        });
        const id = waitpoint.id;
        const record = waitpointKeys(id).record;
        const parent = { runId: "unselected-parent", blockId: "B1", absorptionId: "A1" };
        await store.prepareRegistrationSources({
          ...parent,
          waitpointIds: [id],
          evidence: "!request:held",
        });
        expect(await redis.hget(record, "rh")).toBe("1");
        expect(await redis.hget(record, "ka")).toBeNull();
        expect(await redis.hget(record, "status")).toBe("PENDING");
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "isolated-test",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        const { plan } = await recovery.discover({
          organizationId: env.organization.id,
          kind: "pending-sources",
          partition: fanoutPartition(id),
        });
        const source = plan.sources.find((source) => source.waitpointId === id);
        expect(source?.catalogMetadata).toBeDefined();
        expect(source?.receiptMetadata).toBeUndefined();
        const before = await redis.hget(record, "r");

        const result = await recovery.apply(plan, [], true, [id]);
        const held = {
          verified: false,
          registrationHold: true,
          disposition: expect.stringContaining("registration hold remains"),
        };
        expect(result.errors).toEqual([]);
        expect(result.sources.find((source) => source.waitpointId === id)).toMatchObject(held);
        expect((await recovery.verify(plan)).sources[0]).toMatchObject(held);
        expect(await redis.pttl(record)).toBe(-1);
        expect(await redis.hget(record, "rh")).toBe("1");
        expect(await redis.hget(record, "status")).toBe("PENDING");
        expect(await redis.hget(record, "r")).toBe(before);
        expect(await store.manualCatalog.getManifest(env.organization.id, id)).toBeTruthy();

        await store.releaseRegistrationSources(parent);
        expect(await redis.hget(record, "rh")).toBeNull();
        expect((await recovery.verify(plan)).sources[0]?.verified).toBe(true);
      } finally {
        await store.quit();
        await redis.quit();
      }
    }
  );
  for (const dial of ["off", "redis-only"] as const) {
    containerTest(
      `MANUAL keys, callback authorization and output with TRES ${dial}`,
      async ({ prisma, redisOptions }) => {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"'
        );
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        let enabled = true;
        const engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          resolveDial: () => dial,
          isWaitpointStoreEnabled: () => enabled,
          recoveryDelayMs: 60000,
        });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["parent"]);
          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: RunId.generate().friendlyId,
            taskIdentifier: "parent",
          });
          await dequeueAndStart(engine, "manual-parent");
          const params = {
            runId: parent.id,
            environmentId: env.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
          };
          const [first, second] = await Promise.all([
            engine.createManualWaitpoint({
              ...params,
              idempotencyKey: "manual-key",
              timeout: new Date(Date.now() + 60000),
            }),
            engine.createManualWaitpoint({
              ...params,
              idempotencyKey: "manual-key",
              timeout: new Date(Date.now() + 120000),
            }),
          ]);
          expect(first.waitpoint.id).toBe(second.waitpoint.id);
          expect(first.isCached !== second.isCached).toBe(true);
          expect(parseWaitpointId(first.waitpoint.id)).toMatchObject({
            format: "b32hexW",
            type: "MANUAL",
          });
          expect(await prisma.waitpoint.count({ where: { id: first.waitpoint.id } })).toBe(0);
          const hash = generateScopedHttpCallbackHash(
            { waitpointId: first.waitpoint.id, environmentId: env.id },
            env.apiKey
          );
          const deps = {
            isWaitpointStoreEnabled: engine.waitpointSystem.isWaitpointStoreEnabled.bind(
              engine.waitpointSystem
            ),
            getWaitpoint: engine.getStoreDateTimeWaitpoint.bind(engine),
            resolveEnvironment: (id: string) =>
              prisma.runtimeEnvironment.findFirst({
                where: { id },
                include: { project: true, organization: true, parentEnvironment: true },
              }),
          };
          expect(
            await resolveScopedWaitpointCallback(first.waitpoint.id, hash, deps)
          ).toHaveProperty("waitpoint");
          expect(
            await engine.getStoreDateTimeWaitpoint({
              ...params,
              waitpointId: first.waitpoint.id,
              projectId: "foreign",
            })
          ).toBeNull();
          await engine.blockRunWithWaitpoint({
            runId: parent.id,
            waitpoints: first.waitpoint.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
          });
          await engine.completeWaitpoint({
            id: first.waitpoint.id,
            organizationId: env.organization.id,
            onlyIfPending: true,
            output: { value: '{"accepted":true}', type: "application/json", isError: false },
          });
          await expect
            .poll(
              async () =>
                (await engine.getRunExecutionData({ runId: parent.id }))?.completedWaitpoints,
              { timeout: 10000, interval: 50, message: "MANUAL output never resumed the parent" }
            )
            .toMatchObject([{ id: first.waitpoint.id, output: '{"accepted":true}' }]);
          const deadline = new Date(Date.now() - 1000);
          const timed = await engine.createManualWaitpoint({
            ...params,
            idempotencyKey: "expired-manual",
            timeout: deadline,
          });
          const cached = await engine.createManualWaitpoint({
            ...params,
            idempotencyKey: "expired-manual",
            timeout: new Date(Date.now() + 120000),
          });
          expect(cached.waitpoint.id).toBe(timed.waitpoint.id);
          expect(cached.waitpoint.completedAfter).toEqual(deadline);
          await expect
            .poll(
              async () =>
                (
                  await engine.getStoreDateTimeWaitpoint({
                    ...params,
                    waitpointId: timed.waitpoint.id,
                  })
                )?.status,
              {
                timeout: 10000,
                interval: 50,
                message: "native MANUAL timeout obligation never completed",
              }
            )
            .toBe("COMPLETED");
          const timedOutput = (await engine.getStoreDateTimeWaitpoint({
            ...params,
            waitpointId: timed.waitpoint.id,
          }))!;
          expect(timedOutput.outputIsError).toBe(true);
          await engine.completeWaitpoint({
            id: timed.waitpoint.id,
            organizationId: env.organization.id,
            onlyIfPending: true,
            output: { value: "late", isError: false },
          });
          expect(
            (await engine.getStoreDateTimeWaitpoint({ ...params, waitpointId: timed.waitpoint.id }))
              ?.output
          ).toBe(timedOutput.output);
          const noDeadline = await engine.createManualWaitpoint({
            ...params,
            idempotencyKey: "permanent-manual",
          });
          await engine.waitpointSystem.recoverDateTimeWaitpoint({
            ...params,
            waitpointId: noDeadline.waitpoint.id,
            completedAfter: new Date(),
            manual: true,
          });
          expect(
            (
              await engine.getStoreDateTimeWaitpoint({
                ...params,
                waitpointId: noDeadline.waitpoint.id,
              })
            )?.status
          ).toBe("PENDING");
          enabled = false;
          const legacy = await engine.createManualWaitpoint({
            ...params,
            idempotencyKey: "legacy",
          });
          expect(parseWaitpointId(legacy.waitpoint.id).format).not.toBe("b32hexW");
          enabled = true;
          expect(
            (await engine.createManualWaitpoint({ ...params, idempotencyKey: "legacy" })).waitpoint
              .id
          ).toBe(legacy.waitpoint.id);
          const standalone = await engine.createManualWaitpoint({
            environmentId: env.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
          });
          expect(parseWaitpointId(standalone.waitpoint.id).format).not.toBe("b32hexW");
        } finally {
          await engine.quit();
          await store.quit();
          await snapshotStore.quit();
        }
      }
    );

    containerTest(
      `BATCH CUID identities, replay and late items with TRES ${dial}`,
      async ({ prisma, redisOptions }) => {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"'
        );
        const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60000 });
        const store = new WaitpointStoreCoordinator({ redisOptions });
        let enabled = true;
        const engine = makeEngine(prisma, redisOptions, {
          store,
          snapshotStore,
          resolveDial: () => dial,
          recoveryDelayMs: 60000,
          isWaitpointStoreEnabled: () => enabled,
        });
        try {
          const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
          await setupBackgroundWorker(engine, env, ["parent", "child"]);
          const parent = await triggerRun(engine, env, prisma, {
            friendlyId: RunId.generate().friendlyId,
            taskIdentifier: "parent",
          });
          await dequeueAndStart(engine, "batch-parent");
          const batch = await prisma.batchTaskRun.create({
            data: {
              friendlyId: "batch_test",
              runtimeEnvironmentId: env.id,
              runCount: 8,
              expectedCount: 8,
              processingJobsCount: 8,
              sealed: true,
              status: "PENDING",
              processingCompletedAt: new Date(),
              options: { traceContext: { kept: true } },
            },
          });
          const wp = await engine.blockRunWithCreatedBatch({
            runId: parent.id,
            batchId: batch.id,
            environmentId: env.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
          });
          expect(wp?.id).toBe(deriveBatchWaitpointId(batch.id));
          expect(parseWaitpointId(wp!.id)).toMatchObject({ format: "b32hexW", type: "BATCH" });
          const durable = await prisma.batchTaskRun.findFirstOrThrow({ where: { id: batch.id } });
          expect(durable.options).toEqual({
            traceContext: { kept: true },
            waitpointStoreId: wp!.id,
          });
          expect(batchStoreWaitpointId(durable.options)).toBe(wp!.id);
          expect(await prisma.waitpoint.count({ where: { completedByBatchId: batch.id } })).toBe(0);
          const admissionStarted = performance.now();
          const children = await Promise.all(
            Array.from({ length: 8 }, async (_, n) => {
              const index = 7 - n;
              const child = await triggerRun(engine, env, prisma, {
                friendlyId: RunId.generate().friendlyId,
                taskIdentifier: "child",
                parentTaskRunId: parent.id,
                resumeParentOnCompletion: true,
                batch: { id: batch.id, index },
              });
              expect(
                await prisma.waitpoint.count({ where: { completedByTaskRunId: child.id } })
              ).toBe(0);
              return { child, index };
            })
          );
          console.log(
            `native batch concurrent admission TRES=${dial} items=8 elapsedMs=${performance.now() - admissionStarted}`
          );
          for (let n = 0; n < children.length; n++) {
            const attempt = await dequeueAndStart(engine, `child-${n}`);
            const item = children.find(({ child }) => child.id === attempt.run.id)!;
            await engine.completeRunAttempt({
              runId: item.child.id,
              snapshotId: attempt.snapshot.id,
              completion: {
                id: item.child.id,
                ok: true,
                output: JSON.stringify({ index: item.index }),
                outputType: "application/json",
              },
            });
          }
          await engine.batchSystem.performCompleteBatch({
            batchId: batch.id,
            organizationId: env.organization.id,
          });
          await expect
            .poll(
              async () =>
                (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus,
              { timeout: 10000, interval: 50, message: "BATCH never resumed" }
            )
            .toBe("EXECUTING");
          const completed = await engine.getRunExecutionData({ runId: parent.id });
          expect(
            completed?.completedWaitpoints
              .filter((w) => w.type === "RUN")
              .map((w) => ({ index: w.index, output: JSON.parse(w.output!) }))
              .sort((a, b) => a.index! - b.index!)
          ).toEqual(Array.from({ length: 8 }, (_, index) => ({ index, output: { index } })));
          expect(
            await engine.blockRunWithCreatedBatch({
              runId: parent.id,
              batchId: batch.id,
              environmentId: env.id,
              projectId: env.project.id,
              organizationId: env.organization.id,
            })
          ).toBeNull();
          const child = await engine.createManualWaitpoint({
            runId: parent.id,
            projectId: env.project.id,
            environmentId: env.id,
            organizationId: env.organization.id,
          });
          await engine.waitpointSystem.blockBatchChild({
            runId: parent.id,
            waitpointId: child.waitpoint.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
            batch: { id: batch.id, index: 0 },
          });
          expect(
            (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus
          ).toBe("EXECUTING");
          const expiring = await prisma.batchTaskRun.create({
            data: {
              friendlyId: "batch_expiry",
              runtimeEnvironmentId: env.id,
              runCount: 3,
              expectedCount: 3,
              sealed: false,
              status: "PENDING",
            },
          });
          const expiringWp = await engine.blockRunWithCreatedBatch({
            runId: parent.id,
            batchId: expiring.id,
            environmentId: env.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
          });
          await engine.expireBatch({ batchId: expiring.id, organizationId: env.organization.id });
          await engine.expireBatch({ batchId: expiring.id, organizationId: env.organization.id });
          await expect
            .poll(
              async () =>
                (await engine.getRunExecutionData({ runId: parent.id }))?.completedWaitpoints.find(
                  (w) => w.id === expiringWp!.id
                )?.outputIsError,
              {
                timeout: 10000,
                interval: 50,
                message: "native BATCH expiry did not preserve its error",
              }
            )
            .toBe(true);
          const completedBeforePublish = await prisma.batchTaskRun.create({
            data: {
              friendlyId: "batch_recovery",
              runtimeEnvironmentId: env.id,
              runCount: 0,
              status: "COMPLETED",
            },
          });
          const recoveredId = deriveBatchWaitpointId(completedBeforePublish.id)!;
          const snapshot = (await engine.getRunExecutionData({ runId: parent.id }))!.snapshot;
          await engine.runStore.markBatchWaitpointOnStore(completedBeforePublish.id, recoveredId);
          const recovery = {
            runId: parent.id,
            batchId: completedBeforePublish.id,
            projectId: env.project.id,
            environmentId: env.id,
            organizationId: env.organization.id,
            cycleAnchor: cycleAnchorSnapshotId(snapshot),
          };
          await engine.waitpointSystem.recoverBatchWaitpoint(recovery);
          await expect
            .poll(
              async () =>
                (await engine.getRunExecutionData({ runId: parent.id }))?.completedWaitpoints.find(
                  (w) => w.id === recoveredId
                )?.output,
              {
                timeout: 10000,
                interval: 50,
                message: "committed batch publication recovery never resumed",
              }
            )
            .toBe("Batch waitpoint completed");
          await engine.waitpointSystem.recoverBatchWaitpoint(recovery);
          enabled = false;
          const legacyBatch = await prisma.batchTaskRun.create({
            data: {
              friendlyId: "batch_legacy",
              runtimeEnvironmentId: env.id,
              runCount: 1,
              expectedCount: 1,
              sealed: true,
              status: "PENDING",
            },
          });
          await engine.blockRunWithCreatedBatch({
            runId: parent.id,
            batchId: legacyBatch.id,
            environmentId: env.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
          });
          enabled = true;
          const legacyChild = await triggerRun(engine, env, prisma, {
            friendlyId: RunId.generate().friendlyId,
            taskIdentifier: "child",
            parentTaskRunId: parent.id,
            resumeParentOnCompletion: true,
            batch: { id: legacyBatch.id, index: 0 },
          });
          expect(
            await prisma.waitpoint.count({ where: { completedByTaskRunId: legacyChild.id } })
          ).toBe(1);
          expect(
            batchStoreWaitpointId(
              (await prisma.batchTaskRun.findFirstOrThrow({ where: { id: legacyBatch.id } }))
                .options
            )
          ).toBeUndefined();
        } finally {
          await engine.quit();
          await store.quit();
          await snapshotStore.quit();
        }
      }
    );
  }
  containerTest(
    "debounced item arriving after native batch expiry must not reblock the parent",
    async ({ prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"'
      );
      const snapshots = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const engine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore: snapshots,
        resolveDial: () => "off",
        recoveryDelayMs: 60000,
      });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["parent", "child"]);
        const parent = await triggerRun(engine, env, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "parent",
        });
        await dequeueAndStart(engine, "replay-parent");
        const child = await triggerRun(engine, env, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "child",
          debounce: { key: "replay-key", delay: "60s", mode: "leading" },
          delayUntil: new Date(Date.now() + 60000),
        });
        const batch = await prisma.batchTaskRun.create({
          data: {
            friendlyId: "batch_replay_probe",
            runtimeEnvironmentId: env.id,
            runCount: 1,
            expectedCount: 1,
            sealed: false,
            status: "PENDING",
          },
        });
        await engine.blockRunWithCreatedBatch({
          runId: parent.id,
          batchId: batch.id,
          environmentId: env.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
        });
        // Cached idempotency uses this same generic engine boundary. A reused PG child
        // must be admitted while its native header is pending and fenced after it resumes.
        const legacy = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
        });
        const legacyBlock = {
          runId: parent.id,
          waitpoints: legacy.waitpoint.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
          batch: { id: batch.id, index: 7 },
          spanIdToComplete: "cached-span",
        };
        await engine.blockRunWithWaitpoint(legacyBlock);
        expect(
          await prisma.taskRunWaitpoint.count({
            where: { taskRunId: parent.id, waitpointId: legacy.waitpoint.id, batchIndex: 7 },
          })
        ).toBe(1);
        const guardedBlockId = (await store.readBlockState(parent.id)).blockId;
        const legacyRegistration = createHash("sha256")
          .update(JSON.stringify([batch.id, 7, [legacy.waitpoint.id]]))
          .digest("hex");
        expect(
          await engine["worker"].getJob(
            `recoverWaitpointBlock:${parent.id}:${guardedBlockId}:batch:${legacyRegistration}`
          )
        ).toBeNull();
        await engine.completeWaitpoint({
          id: legacy.waitpoint.id,
          organizationId: env.organization.id,
          output: { value: "legacy-result", isError: false },
        });
        await engine.expireBatch({ batchId: batch.id, organizationId: env.organization.id });
        await expect
          .poll(
            async () =>
              (await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.executionStatus,
            { timeout: 10000, interval: 50, message: "batch expiry did not resume parent" }
          )
          .toBe("EXECUTING");
        const before = await engine.getRunExecutionData({ runId: parent.id });
        const edgesBefore = (await store.readBlockState(parent.id)).edges;
        await engine.blockRunWithWaitpoint({ ...legacyBlock, batch: { id: batch.id, index: 8 } });
        expect(
          await prisma.taskRunWaitpoint.count({
            where: { taskRunId: parent.id, waitpointId: legacy.waitpoint.id, batchIndex: 8 },
          })
        ).toBe(0);
        expect((await engine.getRunExecutionData({ runId: parent.id }))?.snapshot.id).toBe(
          before?.snapshot.id
        );
        const replay = await triggerRun(engine, env, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "child",
          debounce: { key: "replay-key", delay: "60s", mode: "leading" },
          delayUntil: new Date(Date.now() + 60000),
          parentTaskRunId: parent.id,
          resumeParentOnCompletion: true,
          batch: { id: batch.id, index: 0 },
        });
        expect(replay.id).toBe(child.id);
        const after = await engine.getRunExecutionData({ runId: parent.id });
        expect(after?.completedWaitpoints).toEqual(before?.completedWaitpoints);
        expect((await store.readBlockState(parent.id)).edges).toEqual(edgesBefore);
        expect(
          after?.snapshot.id,
          "old batch's late debounced item installed a new parent snapshot"
        ).toBe(before?.snapshot.id);
      } finally {
        await engine.quit();
        await store.quit();
        await snapshots.quit();
      }
    }
  );
  containerTest(
    "accepted child recovery finishes after its batch header completes",
    async ({ prisma, redisOptions }) => {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "_completedWaitpoints" DROP CONSTRAINT IF EXISTS "_completedWaitpoints_B_fkey"'
      );
      const snapshots = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const engine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore: snapshots,
        resolveDial: () => "off",
        recoveryDelayMs: 60000,
      });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["parent", "child"]);
        const parent = await triggerRun(engine, env, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "parent",
        });
        await dequeueAndStart(engine, "accepted-parent");
        const child = await triggerRun(engine, env, prisma, {
          friendlyId: RunId.generate().friendlyId,
          taskIdentifier: "child",
          delayUntil: new Date(Date.now() + 60000),
        });
        const batch = await prisma.batchTaskRun.create({
          data: {
            friendlyId: "batch_accepted_probe",
            runtimeEnvironmentId: env.id,
            runCount: 1,
            expectedCount: 1,
            sealed: false,
            status: "PENDING",
          },
        });
        const header = await engine.blockRunWithCreatedBatch({
          runId: parent.id,
          batchId: batch.id,
          environmentId: env.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
        });
        const wp = await engine.getOrCreateRunWaitpoint({
          runId: child.id,
          projectId: env.project.id,
          environmentId: env.id,
          blockingParentRunId: parent.id,
          organizationId: env.organization.id,
          blockingViaBatch: true,
          blockingBatchId: batch.id,
        });
        const operation = (await engine.waitpointSystem.buildStoreBlockOperation({
          runId: parent.id,
          waitpointId: wp.id,
          organizationId: env.organization.id,
        }))!;
        const absorptionId = `${operation.id}:batch:${createHash("sha256")
          .update(JSON.stringify([batch.id, 0, [wp.id]]))
          .digest("hex")}`;
        const replay = {
          runId: parent.id,
          organizationId: env.organization.id,
          projectId: env.project.id,
          waitpoints: [wp.id],
          blockOperation: { ...operation, absorptionId },
          batch: { id: batch.id, index: 0 },
        };
        // Stop after the real phase-one absorption, reproducing a crash before watcher registration.
        await engine.waitpointSystem["coordinator"].absorbBlockers({
          runId: parent.id,
          blockId: operation.id,
          absorptionId,
          organizationId: env.organization.id,
          waitpointIds: [wp.id],
          projectId: env.project.id,
          batchId: batch.id,
          batchIndex: 0,
          requirePendingWaitpointId: header!.id,
        });
        expect(
          await engine.waitpointSystem["coordinator"].hasAbsorbedBlockers({
            runId: parent.id,
            blockId: operation.id,
            absorptionId,
            waitpointIds: [wp.id],
            batchIndex: 0,
            organizationId: env.organization.id,
          })
        ).toBe(true);
        await engine.expireBatch({ batchId: batch.id, organizationId: env.organization.id });
        await expect
          .poll(
            async () => (await store.readBlockState(parent.id)).pendingIds.includes(header!.id),
            { timeout: 10000, interval: 50, message: "header completion was not delivered" }
          )
          .toBe(false);
        await engine.completeWaitpoint({
          id: wp.id,
          organizationId: env.organization.id,
          output: { value: "child-completed", isError: false },
        });
        await engine.waitpointSystem.recoverWaitpointBlock(replay);
        const state = await store.readBlockState(parent.id);
        expect(
          state.pendingIds,
          "accepted child remained pending after its completion and recovery"
        ).not.toContain(wp.id);
      } finally {
        await engine.quit();
        await store.quit();
        await snapshots.quit();
      }
    }
  );
});
