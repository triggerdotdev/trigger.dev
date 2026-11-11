import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { keyedWaitpointTest as containerTest } from "../tests/utils/keyedWaitpointTest.js";
import { PostgresRunStore, RedisSnapshotStore } from "@internal/run-store";
import { createRedisClient } from "@internal/redis";
import { generateWaitpointId, generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { deriveRunWaitpointId } from "./runWaitpointId.js";
import { StoreWaitpointCoordinator } from "./storeWaitpointCoordinator.js";
import { cycleAnchorSnapshotId } from "../systems/waitpointSystem.js";
import {
  makeEngine,
  triggerRun,
  dequeueAndStart,
} from "../tests/utils/storeRunWaitpointLifecycleFixtures.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";
import { ManualWaitpointRollbackRecovery, READ_INDEX_PAGE } from "./manualRollbackRecovery.js";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";
import {
  runBlockKeys,
  runContributionKey,
  runContributionIndexKey,
  runWithdrawalIndexKey,
  organizationRunIndexKey,
  organizationPendingSourceIndexKey,
  organizationSourceReceiptKey,
  idempotencyReceiptKey,
  idempotencyKey as reservationKey,
  candidateMintFenceKey,
  runResultKey,
  runWithdrawalKey,
  waitpointKeys,
  waitpointRelatedRunsKey,
  fanoutIndexKeys,
  fanoutPartition,
} from "./keys.js";

describe("manual rollback recovery", () => {
  containerTest(
    "preserves a keyed winner published after pending-receipt inspection",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ client: redis });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      class PausedStore extends WaitpointStoreCoordinator {
        protected async _beforeIdempotencyReserve(): Promise<void> {
          await gate;
        }
      }
      const paused = new PausedStore({ client: redis });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const id = generateWaitpointId("DATETIME");
        const acceptUntil = Date.now() + 3000;
        const routeEnv = `${env.id}:actual-route`;
        const receiptKey = idempotencyReceiptKey(routeEnv, "raced", id);
        await store.publishPendingSource(id, env.organization.id, {
          key: receiptKey,
          acceptUntil,
        });
        const now = new Date().toISOString();
        const creating = paused.createWithIdempotencyKey({
          record: {
            id,
            friendlyId: `waitpoint_${id}`,
            type: "DATETIME",
            environmentId: env.id,
            organizationId: env.organization.id,
            projectId: env.project.id,
            completedAfter: new Date(Date.now() + 3600000).toISOString(),
            createdAt: now,
            updatedAt: now,
            userProvidedIdempotencyKey: true,
            idempotencyKey: "raced",
            tags: [],
          },
          environmentId: routeEnv,
          idempotencyKey: "raced",
          acceptUntil,
        });
        await expect
          .poll(() => redis.hget(waitpointKeys(id).record, "status"), { timeout: 2000 })
          .toBe("PENDING");
        expect(await redis.get(receiptKey)).toBe("pending");

        const recovery = new ManualWaitpointRollbackRecovery({
          target: "probe",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        // Inspection while the in-flight creation is still inside its publication window.
        const { plan } = await recovery.discover({
          organizationId: env.organization.id,
          kind: "pending-sources",
          partition: fanoutPartition(id),
        });
        const source = plan.sources.find((s) => s.waitpointId === id)!;
        expect(source.receiptValue).toBe("pending");
        expect(source.status).toBe("PENDING");

        // The producer finishes publication before acceptUntil (then is drained).
        release();
        const published = await creating;
        expect(published).toEqual({ waitpointId: id, created: true });
        expect(await redis.get(reservationKey(routeEnv, "raced"))).toBe(id);
        expect(await redis.get(receiptKey)).toBe(id);

        await expect
          .poll(() => Date.now() > acceptUntil + 50, { timeout: 5000, interval: 20 })
          .toBe(true);

        const before = await redis.dump(waitpointKeys(id).record);
        const result = await recovery.apply(plan, [], true, [id]);
        const after = {
          idempotencyKeyMapsTo: await redis.get(reservationKey(routeEnv, "raced")),
          receipt: await redis.get(receiptKey),
          recordExists: await redis.exists(waitpointKeys(id).record),
          mintFence: await redis.get(`${waitpointKeys(id).record}:mint-fence`),
        };
        // Desired invariant per runbook: "Published future winners remain unchanged."
        expect(after.recordExists).toBe(1);
        expect(after.idempotencyKeyMapsTo).toBe(id);
        expect(after.receipt).toBe(id);
        expect(after.mintFence).toBeNull();
        expect(await redis.dump(waitpointKeys(id).record)).toEqual(before);
        expect(result.sources[0]?.verified).toBe(false);
        expect(result.errors).toEqual([]);
        expect(await redis.pttl(receiptKey)).toBe(-1);
        // An acknowledged receipt can age out independently. Missing evidence never proves
        // this permanent published winner was an unpublished candidate.
        await redis.pexpireat(receiptKey, 1);
        const missingReceipt = await recovery.apply(plan, [], true, [id]);
        expect(missingReceipt.sources[0]?.verified).toBe(false);
        expect(await redis.dump(waitpointKeys(id).record)).toEqual(before);
        expect(await redis.get(reservationKey(routeEnv, "raced"))).toBe(id);
        expect(await redis.get(candidateMintFenceKey(id))).toBeNull();
      } finally {
        await store.quit();
        redis.disconnect();
      }
    }
  );
  containerTest(
    "verifies supplied-run elapsed DATETIME completion and removed source indexes",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ client: redis });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const runId = "probe_elapsed_dt";
        await prisma.taskRun.create({
          data: {
            id: runId,
            friendlyId: `run_${runId}`,
            organizationId: env.organizationId,
            projectId: env.projectId,
            runtimeEnvironmentId: env.id,
            engine: "V2",
            status: "CANCELED",
            annotations: { waitpointsOnStore: true },
            taskIdentifier: "task",
            payload: "{}",
            payloadType: "application/json",
            traceId: "trace",
            spanId: "span",
            queue: "task/task",
          },
        });
        const wp = generateWaitpointId("DATETIME");
        const now = new Date().toISOString();
        await store.publishPendingSource(wp, env.organization.id);
        await store.createIfAbsent({
          record: {
            id: wp,
            friendlyId: `waitpoint_${wp}`,
            type: "DATETIME",
            environmentId: env.id,
            organizationId: env.organization.id,
            projectId: env.projectId,
            completedAfter: new Date(Date.now() - 60_000).toISOString(),
            createdAt: now,
            updatedAt: now,
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        await store.registerBlocks({
          runId,
          blockId: "blk1",
          edges: [{ waitpointId: wp, type: "DATETIME", createdAt: now }],
        });
        await store.registerOrReport({ waitpointId: wp, runId, blockId: "blk1", createdAt: now });
        await store.unregisterWatcher({ waitpointId: wp, runId, blockId: "blk1" });
        expect(await redis.pttl(waitpointRelatedRunsKey(wp))).toBe(-1);
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "probe",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        const plan = await recovery.inspect({
          organizationId: env.organization.id,
          runs: [{ runId, blockIds: [], sourceIds: [wp] }],
        });
        const applied = await recovery.apply(plan, [runId], true);
        const reverified = await recovery.verify(plan);
        expect(applied.results[0]?.verified).toBe(true);
        expect(reverified.results[0]?.verified).toBe(true);
        expect(applied.results[0]).toMatchObject({
          sources: [
            {
              waitpointId: wp,
              verified: true,
              disposition: "registry-owned source converged",
            },
          ],
        });
        expect(await redis.hget(waitpointKeys(wp).record, "status")).toBe("COMPLETED");
        expect(await redis.pttl(waitpointKeys(wp).record)).toBeGreaterThan(0);
        expect(await redis.zscore(waitpointRelatedRunsKey(wp), runId)).toBe("0");
        expect(await redis.pttl(waitpointRelatedRunsKey(wp))).toBeGreaterThan(0);
        expect(
          Math.abs(
            (await redis.pttl(waitpointKeys(wp).record)) -
              (await redis.pttl(waitpointRelatedRunsKey(wp)))
          )
        ).toBeLessThan(100);
        const index = organizationPendingSourceIndexKey(env.organization.id, fanoutPartition(wp));
        expect(await redis.zscore(index, wp)).toBeNull();
        // Verification must also reject an interrupted cross-slot index retirement.
        await redis.zadd(index, 0, wp);
        expect((await recovery.verify(plan)).results[0]?.verified).toBe(false);
        await redis.zrem(index, wp);
        expect((await recovery.apply(plan, [runId], true)).results[0]?.verified).toBe(true);

        // A completed source can be reviewed through either discovery or a supplied run.
        // Exercise both public verification paths against the same real Redis state.
        const completedPlan = await recovery.inspect({
          organizationId: env.organization.id,
          runs: [{ runId, blockIds: [], sourceIds: [wp] }],
        });
        const completedSource = completedPlan.entries[0]!.sources[0]!;
        expect(completedSource.status).toBe("COMPLETED");
        expect(completedSource.pendingRegistryOwned).toBe(false);
        expect(completedSource.receiptMetadata).toBeUndefined();
        const sourcePlan = { ...completedPlan, entries: [], sources: [completedSource] };
        const assertVerified = async (verified: boolean) => {
          expect((await recovery.verify(completedPlan)).results[0]).toMatchObject({
            verified,
            sources: [{ waitpointId: wp, verified }],
          });
          expect((await recovery.verify(sourcePlan)).sources).toEqual([
            { waitpointId: wp, verified },
          ]);
        };
        const sourceKey = waitpointKeys(wp).record;
        const relatedKey = waitpointRelatedRunsKey(wp);
        await assertVerified(true);
        // Persistent history must not survive a finite source.
        await redis.persist(relatedKey);
        await assertVerified(false);
        // Copy one absolute deadline atomically, without timing-sensitive PTTL assertions.
        await redis.eval(
          `local t = redis.call('TIME')
           local expiry = tonumber(t[1])*1000 + math.floor(tonumber(t[2])/1000) + 60000
           redis.call('PEXPIREAT',KEYS[1],expiry)
           redis.call('PEXPIREAT',KEYS[2],expiry)`,
          2,
          sourceKey,
          relatedKey
        );
        await assertVerified(true);
        await redis.pexpire(relatedKey, 30000);
        await assertVerified(false);
        // Missing history is normal for RUN and sources with no subscriptions.
        await redis.unlink(relatedKey);
        await assertVerified(true);
        // A permanent source requires any present history to remain permanent too.
        await redis.hset(sourceKey, "ku", "-1");
        await redis.persist(sourceKey);
        await redis.zadd(relatedKey, 0, runId);
        await assertVerified(true);
        await redis.pexpire(relatedKey, 60000);
        await assertVerified(false);
        await redis.persist(relatedKey);
        await redis.unlink(sourceKey);
        await assertVerified(false);
        await redis.unlink(relatedKey);
        await assertVerified(true);
      } finally {
        await store.quit();
        redis.disconnect();
      }
    }
  );

  containerTest(
    "discovers native publications after disabled RUN/deadline jobs disappear and reclaims only reviewed eligible sources",
    async ({ prisma, redisOptions }) => {
      let enabled = true;
      const redis = createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ client: redis });
      const snapshots = new RedisSnapshotStore({ redisOptions });
      const engine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore: snapshots,
        resolveDial: () => "off",
        recoveryDelayMs: 1500,
        isWaitpointStoreEnabled: () => enabled,
      });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["parent-task", "child-task"]);
        const parent = await triggerRun(engine, env, prisma, {
          friendlyId: `run_${generateRunOpsId()}`,
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(engine, "pending_parent");
        const normalKeyed = await engine.createDateTimeWaitpoint({
          runId: parent.id,
          organizationId: env.organization.id,
          environmentId: env.id,
          projectId: env.project.id,
          completedAfter: new Date(Date.now() + 100),
          idempotencyKey: "normal-keyed",
        });
        const normalReceiptKey = JSON.parse(
          (await redis.hget(
            organizationSourceReceiptKey(
              env.organization.id,
              fanoutPartition(normalKeyed.waitpoint.id)
            ),
            normalKeyed.waitpoint.id
          ))!
        ).key as string;
        await expect
          .poll(
            () => engine.worker.getJob(`recoverDateTimeWaitpoint:${normalKeyed.waitpoint.id}`),
            { timeout: 10000, interval: 50 }
          )
          .toBeNull();
        expect(await redis.hget(waitpointKeys(normalKeyed.waitpoint.id).record, "ka")).toBeNull();
        expect(
          await redis.zscore(
            organizationPendingSourceIndexKey(
              env.organization.id,
              fanoutPartition(normalKeyed.waitpoint.id)
            ),
            normalKeyed.waitpoint.id
          )
        ).toBeNull();

        expect(await redis.pttl(normalReceiptKey)).toBeGreaterThan(0);
        expect(
          await redis.hexists(
            organizationSourceReceiptKey(
              env.organization.id,
              fanoutPartition(normalKeyed.waitpoint.id)
            ),
            normalKeyed.waitpoint.id
          )
        ).toBe(0);
        const child = await triggerRun(engine, env, prisma, {
          friendlyId: `run_${generateRunOpsId()}`,
          taskIdentifier: "child-task",
          parentTaskRunId: parent.id,
          resumeParentOnCompletion: true,
        });
        const runSource = deriveRunWaitpointId(child.id)!;
        const dateParams = {
          runId: parent.id,
          organizationId: env.organization.id,
          environmentId: env.id,
          projectId: env.project.id,
        };
        const deadline = new Date(Date.now() + 1500);
        const plain = await engine.createDateTimeWaitpoint({
          ...dateParams,
          completedAfter: deadline,
        });
        const keyed = await engine.createDateTimeWaitpoint({
          ...dateParams,
          completedAfter: deadline,
          idempotencyKey: "permanent-deadline",
        });
        const future = await engine.createDateTimeWaitpoint({
          ...dateParams,
          completedAfter: new Date(Date.now() + 3600000),
        });
        const completedBeforeRollback = await engine.createDateTimeWaitpoint({
          ...dateParams,
          completedAfter: deadline,
          idempotencyKey: "completed-before-rollback",
        });
        await engine.completeWaitpoint({
          id: completedBeforeRollback.waitpoint.id,
          organizationId: env.organization.id,
          onlyIfPending: true,
        });
        expect(
          await redis.hget(waitpointKeys(completedBeforeRollback.waitpoint.id).record, "ka")
        ).not.toBeNull();
        const owned = [
          runSource,
          plain.waitpoint.id,
          keyed.waitpoint.id,
          future.waitpoint.id,
          completedBeforeRollback.waitpoint.id,
        ];
        for (const id of owned)
          expect(
            await redis.zscore(
              organizationPendingSourceIndexKey(env.organization.id, fanoutPartition(id)),
              id
            )
          ).toBe("0");
        const receipts = new Map<string, string>();
        for (const id of [keyed.waitpoint.id, completedBeforeRollback.waitpoint.id]) {
          const metadata = JSON.parse(
            (await redis.hget(
              organizationSourceReceiptKey(env.organization.id, fanoutPartition(id)),
              id
            ))!
          );
          receipts.set(id, metadata.key);
          expect(await redis.pttl(metadata.key)).toBe(-1);
        }
        expect(
          await redis.get(idempotencyReceiptKey(env.id, "permanent-deadline", keyed.waitpoint.id))
        ).toBeNull();
        let interruptedReceiptCleanup = false;
        enabled = false;
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        await engine.cancelRun({
          runId: child.id,
          organizationId: env.organization.id,
          finalizeRun: true,
        });
        await engine.cancelRun({
          runId: parent.id,
          organizationId: env.organization.id,
          finalizeRun: true,
        });
        await expect
          .poll(() => engine.worker.getJob(`recoverRunWaitpoint:${child.id}`), {
            timeout: 10000,
            interval: 50,
          })
          .toBeNull();
        for (const id of [
          plain.waitpoint.id,
          keyed.waitpoint.id,
          completedBeforeRollback.waitpoint.id,
        ])
          await expect
            .poll(() => engine.worker.getJob(`recoverDateTimeWaitpoint:${id}`), {
              timeout: 10000,
              interval: 50,
            })
            .toBeNull();
        for (const id of owned.filter((id) => id !== completedBeforeRollback.waitpoint.id))
          expect(await redis.hget(waitpointKeys(id).record, "status")).toBe("PENDING");
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "pending",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        // Organization discovery first withdraws the terminal parent's watcher, without source IDs.
        const parentPlan = await recovery.discover({
          organizationId: env.organization.id,
          kind: "runs",
          partition: fanoutPartition(parent.id),
        });
        expect((await recovery.apply(parentPlan.plan, [parent.id], true)).results[0]).toMatchObject(
          { verified: true }
        );
        // Native state already converged but final registry retirement was interrupted.
        await store.publishRunOwnership(parent.id, env.organization.id);
        expect(
          (await recovery.verify(parentPlan.plan)).results.find(
            (result) => result.runId === parent.id
          )?.verified
        ).toBe(false);
        expect((await recovery.apply(parentPlan.plan, [parent.id], true)).results[0]).toMatchObject(
          { verified: true }
        );
        const found: string[] = [];
        for (let partition = 0; partition < 16; partition++) {
          const { plan } = await recovery.discover({
            organizationId: env.organization.id,
            kind: "pending-sources",
            partition,
          });
          found.push(...plan.sources.map((source) => source.waitpointId));
          const selected = plan.sources
            .filter((source) => source.waitpointId !== future.waitpoint.id)
            .map((source) => source.waitpointId);
          if (plan.sources.some((source) => source.waitpointId === future.waitpoint.id)) {
            const before = await redis.dump(waitpointKeys(future.waitpoint.id).record);
            await recovery.apply(plan, [], true, [future.waitpoint.id]);
            expect(await redis.dump(waitpointKeys(future.waitpoint.id).record)).toEqual(before);
          }
          if (selected.length) {
            const receiptSource = plan.sources.find(
              (source) => source.receiptMetadata && selected.includes(source.waitpointId)
            );
            if (receiptSource && !interruptedReceiptCleanup) {
              const username = `receipt_${randomUUID().replaceAll("-", "")}`,
                password = randomUUID();
              await redis.acl("SETUSER", username, "on", `>${password}`, "~*", "+@all", "-zrem");
              const limited = createRedisClient({ ...redisOptions, username, password });
              try {
                const interrupted = new ManualWaitpointRollbackRecovery({
                  target: "pending",
                  controlPlane: prisma,
                  runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
                  redis: limited,
                  store,
                });
                const failed = await interrupted.apply(
                  { ...plan, entries: parentPlan.plan.entries },
                  [parent.id],
                  true,
                  [receiptSource.waitpointId]
                );
                expect(failed.results[0]).toMatchObject({ runId: parent.id, verified: true });
                expect(failed.errors).toContainEqual({
                  stage: "source-cleanup",
                  waitpointId: receiptSource.waitpointId,
                  error: expect.stringMatching(/permission|NOPERM/i),
                });
                expect(
                  await redis.pttl(JSON.parse(receiptSource.receiptMetadata!).key)
                ).toBeGreaterThan(0);
                expect(
                  await redis.zscore(
                    organizationPendingSourceIndexKey(env.organization.id, partition),
                    receiptSource.waitpointId
                  )
                ).toBe("0");
                interruptedReceiptCleanup = true;
              } finally {
                await limited.quit();
                await redis.acl("DELUSER", username);
              }
            }
            const result = await recovery.apply(plan, [], true, selected);
            expect(result.sources.every((source) => source.verified)).toBe(true);
            expect(
              (await recovery.apply(plan, [], true, selected)).sources.every(
                (source) => source.verified
              )
            ).toBe(true);
          }
        }
        expect(found.sort()).toEqual(owned.sort());
        expect(interruptedReceiptCleanup).toBe(true);
        for (const [id, key] of receipts) {
          expect(await redis.pttl(key)).toBeGreaterThan(0);
          expect(
            await redis.hexists(
              organizationSourceReceiptKey(env.organization.id, fanoutPartition(id)),
              id
            )
          ).toBe(0);
        }

        // A later normal ACK can mark the manually retained receipt completed and then
        // crash before its final ACK. The existing finite retention must survive that SET.
        const retainedReceipt = receipts.get(keyed.waitpoint.id)!;
        const receiptTtl = await redis.pttl(retainedReceipt);
        await redis.wpCompleteIdemReceipt(retainedReceipt, keyed.waitpoint.id);
        expect(await redis.pttl(retainedReceipt)).toBeGreaterThan(0);
        expect(await redis.pttl(retainedReceipt)).toBeLessThanOrEqual(receiptTtl);
        expect(await redis.hget(waitpointKeys(runSource).record, "status")).toBe("PENDING");
        expect(await redis.hget(waitpointKeys(runSource).record, "c")).toBeNull();
        expect(await redis.pttl(waitpointKeys(runSource).record)).toBeGreaterThan(0);
        for (const id of [plain.waitpoint.id, keyed.waitpoint.id]) {
          const source = (await store.readCompletedRecords([id])).get(id)!;
          expect(source.status).toBe("COMPLETED");
          expect(source.completion).toMatchObject({ output: null, outputIsError: false });
        }
        expect(await redis.pttl(waitpointKeys(plain.waitpoint.id).record)).toBeGreaterThan(0);
        expect(await redis.pttl(waitpointKeys(keyed.waitpoint.id).record)).toBe(-1);
        expect(await redis.hget(waitpointKeys(keyed.waitpoint.id).record, "ka")).toBeNull();
        expect(await redis.hget(waitpointKeys(future.waitpoint.id).record, "status")).toBe(
          "PENDING"
        );
        expect(await redis.pttl(waitpointKeys(future.waitpoint.id).record)).toBe(-1);
        enabled = true;
        const reused = await engine.createDateTimeWaitpoint({
          ...dateParams,
          completedAfter: deadline,
          idempotencyKey: "permanent-deadline",
        });
        expect(reused.waitpoint.id).toBe(keyed.waitpoint.id);
        expect(reused.isCached).toBe(true);
        await engine.completeWaitpoint({
          id: keyed.waitpoint.id,
          organizationId: env.organization.id,
          onlyIfPending: true,
        });
        expect(
          (await store.readCompletedRecords([keyed.waitpoint.id])).get(keyed.waitpoint.id)
            ?.completion?.output
        ).toBeNull();
      } finally {
        await engine.quit();
        await snapshots.quit();
        await store.quit();
        redis.disconnect();
      }
    }
  );

  containerTest(
    "keeps source provenance through quarantined record expiry and atomically republishes it for duplicate completion",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions),
        store = new WaitpointStoreCoordinator({ client: redis });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const adapter = new StoreWaitpointCoordinator({ store });
        const data = adapter.mintAssociatedWaitpointData({
          projectId: env.project.id,
          environmentId: env.id,
          anchorRunId: "cm5sk0xtl000108lae4r22lys",
        });
        // Use the adapter's normal publication path, and a real watcher to retain fanout.
        await adapter.createAssociatedWaitpoint({
          runId: "child",
          data,
          organizationId: env.organization.id,
        });
        const index = organizationPendingSourceIndexKey(
          env.organization.id,
          fanoutPartition(data.id)
        );
        await store.registerBlocks({
          runId: "watcher",
          blockId: "b",
          edges: [{ waitpointId: data.id, type: "RUN", createdAt: new Date().toISOString() }],
        });
        const completion = {
          completedAt: new Date().toISOString(),
          outputType: "application/json",
          outputIsError: false,
          output: null,
        };
        await store.complete({
          waitpointId: data.id,
          completion,
          organizationId: env.organization.id,
        });
        expect(await redis.zscore(index, data.id)).toBe("0");
        await store.unregisterWatcher({ waitpointId: data.id, runId: "watcher", blockId: "b" });
        const hints = fanoutIndexKeys(fanoutPartition(data.id));
        await redis.zrem(hints.due, data.id);
        await redis.zadd(hints.quarantine, 0, data.id);
        await store.dropFanoutHint(data.id);
        expect(await redis.zscore(index, data.id)).toBe("0");
        await redis.unlink(...Object.values(waitpointKeys(data.id)));
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "expired",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        const { plan } = await recovery.discover({
          organizationId: env.organization.id,
          kind: "pending-sources",
          partition: fanoutPartition(data.id),
        });
        expect(plan.sources).toHaveLength(1);
        expect((await recovery.apply(plan, [], true, [data.id])).sources[0]).toMatchObject({
          verified: true,
        });
        expect(await redis.zscore(hints.quarantine, data.id)).toBeNull();
        expect(await redis.zscore(index, data.id)).toBeNull();
        // Fresh native source: no watchers completes and retires ownership. A duplicate must
        // atomically republish ownership with its preflip hint even if the source write fails.
        const second = adapter.mintAssociatedWaitpointData({
          projectId: env.project.id,
          environmentId: env.id,
          anchorRunId: "cm5sk0xtl000208lae4r22lys",
        });
        await adapter.createAssociatedWaitpoint({
          runId: "child2",
          data: second,
          organizationId: env.organization.id,
        });
        await store.complete({
          waitpointId: second.id,
          completion,
          organizationId: env.organization.id,
        });
        const secondIndex = organizationPendingSourceIndexKey(
          env.organization.id,
          fanoutPartition(second.id)
        );
        expect(await redis.zscore(secondIndex, second.id)).toBeNull();
        await redis.unlink(waitpointKeys(second.id).record);
        await expect(
          store.complete({
            waitpointId: second.id,
            completion,
            organizationId: env.organization.id,
          })
        ).rejects.toThrow();
        expect(await redis.zscore(secondIndex, second.id)).toBe("0");
        expect(
          await redis.zscore(fanoutIndexKeys(fanoutPartition(second.id)).due, second.id)
        ).not.toBeNull();
        const orphan = adapter.mintAssociatedWaitpointData({
          projectId: env.project.id,
          environmentId: env.id,
          anchorRunId: "cm5sk0xtl000308lae4r22lys",
        });
        await adapter.createAssociatedWaitpoint({
          runId: "missing_child",
          data: orphan,
          organizationId: env.organization.id,
        });
        await prisma.runtimeEnvironment.delete({ where: { id: env.id } });
        const orphanPlan = await recovery.discover({
          organizationId: env.organization.id,
          kind: "pending-sources",
          partition: fanoutPartition(orphan.id),
        });
        expect(orphanPlan.plan.sources.map((source) => source.waitpointId)).toContain(orphan.id);
        expect(
          (await recovery.apply(orphanPlan.plan, [], true, [orphan.id])).sources[0]
        ).toMatchObject({ verified: true });
        expect(await redis.pttl(waitpointKeys(orphan.id).record)).toBeGreaterThan(0);
      } finally {
        await store.quit();
        redis.disconnect();
      }
    }
  );

  containerTest(
    "retains exact receipts for closed losers and cancels unpublished future candidates after their publication fence",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions),
        store = new WaitpointStoreCoordinator({ client: redis });
      class InterruptedCandidateStore extends WaitpointStoreCoordinator {
        protected async _beforeIdempotencyReserve(): Promise<void> {
          throw new Error("interrupted before reservation");
        }
      }
      const interruptedStore = new InterruptedCandidateStore({ client: redis });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const adapter = new StoreWaitpointCoordinator({ store });
        const params = {
          projectId: env.project.id,
          environmentId: env.id,
          mintContext: { organizationId: env.organization.id },
          completedAfter: new Date(Date.now() + 3600000),
          idempotencyKey: "receipt-losers",
        };
        const winner = await adapter.createDateTimeWaitpoint(params);
        const loserId = generateWaitpointId("DATETIME"),
          survivingLoserId = generateWaitpointId("DATETIME"),
          ackedLoserId = generateWaitpointId("DATETIME");
        const username = `loser_${randomUUID().replaceAll("-", "")}`,
          password = randomUUID();
        await redis.acl("SETUSER", username, "on", `>${password}`, "~*", "+@all", "-del");
        const limitedRedis = createRedisClient({ ...redisOptions, username, password });
        const limitedStore = new WaitpointStoreCoordinator({ client: limitedRedis });
        try {
          const limitedAdapter = new StoreWaitpointCoordinator({ store: limitedStore });
          await expect(
            limitedAdapter.createDateTimeWaitpoint({ ...params, storeId: survivingLoserId })
          ).rejects.toThrow(/permission|NOPERM|ACL/i);
          expect(await store.probeWaitpointPresence(survivingLoserId)).toBe("present");
        } finally {
          await limitedStore.quit();
          limitedRedis.disconnect();
          await redis.acl("DELUSER", username);
        }
        await adapter.createDateTimeWaitpoint({ ...params, storeId: loserId });
        await adapter.createDateTimeWaitpoint({ ...params, storeId: ackedLoserId });
        for (const id of [loserId, ackedLoserId]) {
          expect(await store.probeWaitpointPresence(id)).toBe("absent");
          expect(
            await redis.zscore(
              organizationPendingSourceIndexKey(env.organization.id, fanoutPartition(id)),
              id
            )
          ).toBe("0");
        }
        const acknowledged = JSON.parse(
          (await redis.hget(
            organizationSourceReceiptKey(env.organization.id, fanoutPartition(ackedLoserId)),
            ackedLoserId
          ))!
        );
        await store.acknowledgeIdempotencyCandidate({
          candidateId: ackedLoserId,
          organizationId: env.organization.id,
          environmentId: env.id,
          idempotencyKey: params.idempotencyKey,
          acceptUntil: acknowledged.acceptUntil,
          winnerId: winner.waitpoint.id,
        });
        expect(await redis.pttl(acknowledged.key)).toBeGreaterThan(0);
        expect(
          await redis.hexists(
            organizationSourceReceiptKey(env.organization.id, fanoutPartition(ackedLoserId)),
            ackedLoserId
          )
        ).toBe(0);
        expect(
          await redis.zscore(
            organizationPendingSourceIndexKey(env.organization.id, fanoutPartition(ackedLoserId)),
            ackedLoserId
          )
        ).toBeNull();
        const unpublishedId = generateWaitpointId("DATETIME"),
          acceptUntil = Date.now() + 100;
        const receiptKey = idempotencyReceiptKey(
          `${env.id}:actual-route`,
          "unpublished",
          unpublishedId
        );
        await store.publishPendingSource(unpublishedId, env.organization.id, {
          key: receiptKey,
          acceptUntil,
        });
        const now = new Date().toISOString();
        await expect(
          interruptedStore.createWithIdempotencyKey({
            record: {
              id: unpublishedId,
              friendlyId: `waitpoint_${unpublishedId}`,
              type: "DATETIME",
              environmentId: env.id,
              organizationId: env.organization.id,
              projectId: env.project.id,
              completedAfter: params.completedAfter.toISOString(),
              createdAt: now,
              updatedAt: now,
              userProvidedIdempotencyKey: true,
              idempotencyKey: "unpublished",
              tags: [],
            },
            environmentId: `${env.id}:actual-route`,
            idempotencyKey: "unpublished",
            acceptUntil,
          })
        ).rejects.toThrow("interrupted before reservation");
        expect(await redis.get(receiptKey)).toBe("pending");
        await store.registerOrReport({
          waitpointId: unpublishedId,
          runId: "discarded-related-run",
          blockId: "discarded",
          createdAt: now,
        });
        await store.unregisterWatcher({
          waitpointId: unpublishedId,
          runId: "discarded-related-run",
          blockId: "discarded",
        });
        expect(await redis.zcard(waitpointRelatedRunsKey(unpublishedId))).toBe(1);
        await expect
          .poll(() => Date.now() > acceptUntil, { timeout: 2000, interval: 20 })
          .toBe(true);
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "receipts",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        for (const id of [loserId, survivingLoserId, unpublishedId]) {
          const { plan } = await recovery.discover({
            organizationId: env.organization.id,
            kind: "pending-sources",
            partition: fanoutPartition(id),
          });
          const source = plan.sources.find((source) => source.waitpointId === id)!;
          expect(source.receiptMetadata).toBeDefined();
          expect((await recovery.apply(plan, [], true, [id])).sources[0]).toMatchObject({
            verified: true,
          });
          expect((await recovery.apply(plan, [], true, [id])).sources[0]).toMatchObject({
            verified: true,
          });
          expect(await redis.pttl(JSON.parse(source.receiptMetadata!).key)).toBeGreaterThan(0);
          expect(await store.probeWaitpointPresence(id)).toBe("absent");
          expect(await redis.pttl(candidateMintFenceKey(id))).toBeGreaterThan(0);
        }
        expect(await redis.get(receiptKey)).toBe("cancelled");
        expect(await redis.exists(waitpointRelatedRunsKey(unpublishedId))).toBe(0);
        expect(await redis.hget(waitpointKeys(winner.waitpoint.id).record, "status")).toBe(
          "PENDING"
        );
        expect((await adapter.createDateTimeWaitpoint(params)).waitpoint.id).toBe(
          winner.waitpoint.id
        );
        // Normal ACK may finish before cross-slot registry retirement is interrupted.
        // Once its finite receipt expires, an already closed loser leaves only bookkeeping.
        const expiredAckId = generateWaitpointId("DATETIME");
        const expiredAcceptUntil = Date.now() + 1000;
        await adapter.createDateTimeWaitpoint({
          ...params,
          storeId: expiredAckId,
          keyedCreation: { acceptUntil: expiredAcceptUntil, scope: env.id, claimToken: "" },
        });
        const expiredMetadataKey = organizationSourceReceiptKey(
          env.organization.id,
          fanoutPartition(expiredAckId)
        );
        const expiredMetadata = await redis.hget(expiredMetadataKey, expiredAckId);
        const expiredReceipt = JSON.parse(expiredMetadata!);
        await store.acknowledgeIdempotencyCandidate({
          candidateId: expiredAckId,
          environmentId: env.id,
          idempotencyKey: params.idempotencyKey,
          acceptUntil: expiredAcceptUntil,
          winnerId: winner.waitpoint.id,
        });
        expect(await redis.pttl(expiredReceipt.key)).toBeGreaterThan(0);
        expect(await redis.hget(expiredMetadataKey, expiredAckId)).toBe(expiredMetadata);
        await redis.pexpireat(expiredReceipt.key, 1);
        const expiredPlan = (
          await recovery.discover({
            organizationId: env.organization.id,
            kind: "pending-sources",
            partition: fanoutPartition(expiredAckId),
          })
        ).plan;
        expect(
          expiredPlan.sources.find((source) => source.waitpointId === expiredAckId)
        ).toMatchObject({ record: "", receiptValue: null });
        const stillOpen = await recovery.apply(expiredPlan, [], true, [expiredAckId]);
        expect(stillOpen.sources[0]?.verified).toBe(false);
        expect(await redis.hget(expiredMetadataKey, expiredAckId)).toBe(expiredMetadata);
        await expect
          .poll(
            async () => {
              const time = await redis.time();
              return (
                Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000) > expiredAcceptUntil
              );
            },
            { timeout: 3000, interval: 20 }
          )
          .toBe(true);
        const expiredResult = await recovery.apply(expiredPlan, [], true, [expiredAckId]);
        expect(expiredResult.errors).toEqual([]);
        expect(expiredResult.sources[0]?.verified).toBe(true);
        expect(await redis.hget(expiredMetadataKey, expiredAckId)).toBeNull();
        expect(
          await redis.zscore(
            organizationPendingSourceIndexKey(env.organization.id, fanoutPartition(expiredAckId)),
            expiredAckId
          )
        ).toBeNull();
        expect(
          (await recovery.apply(expiredPlan, [], true, [expiredAckId])).sources[0]?.verified
        ).toBe(true);
      } finally {
        await store.quit();
        redis.disconnect();
      }
    }
  );

  containerTest(
    "discovers completed future/quarantined sources without run IDs and retains unknown/foreign hints",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions),
        store = new WaitpointStoreCoordinator({ client: redis });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const foreignOrg = await prisma.organization.create({
          data: { title: "Foreign", slug: "foreign" },
        });
        const foreignProject = await prisma.project.create({
          data: {
            name: "Foreign",
            slug: "foreign",
            externalRef: "foreign",
            organizationId: foreignOrg.id,
          },
        });
        const foreign = await prisma.runtimeEnvironment.create({
          data: {
            type: "PRODUCTION",
            slug: "foreign",
            projectId: foreignProject.id,
            organizationId: foreignOrg.id,
            apiKey: "foreign_api",
            pkApiKey: "foreign_pk",
            shortcode: "foreign_code",
          },
        });
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "discovery",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        for (const kind of ["due", "quarantine"] as const) {
          const wp = generateWaitpointId("RUN"),
            now = new Date().toISOString();
          await store.createIfAbsent({
            record: {
              id: wp,
              friendlyId: `waitpoint_${wp}`,
              type: "RUN",
              environmentId: env.id,
              projectId: env.project.id,
              createdAt: now,
              updatedAt: now,
              userProvidedIdempotencyKey: false,
              tags: [],
            },
            status: "PENDING",
          });
          await store.complete({
            waitpointId: wp,
            completion: {
              completedAt: now,
              outputType: "text/plain",
              output: null,
              outputIsError: false,
            },
          });
          const index = fanoutIndexKeys(fanoutPartition(wp));
          await redis.zrem(index.due, wp);
          await redis.zadd(index[kind], Date.now() + 86400000, wp);
          const { plan } = await recovery.discover({
            organizationId: env.organization.id,
            kind,
            partition: fanoutPartition(wp),
          });
          expect(plan.entries).toEqual([]);
          expect(plan.sources.map((s) => s.waitpointId)).toContain(wp);
          const result = await recovery.apply(plan, [], true, [wp]);
          expect(result.sources).toContainEqual({ waitpointId: wp, verified: true });
          expect((await recovery.verify(plan)).sources).toContainEqual({
            waitpointId: wp,
            verified: true,
          });
        }
        const missing = "unknown_source",
          key = fanoutIndexKeys(fanoutPartition(missing)).quarantine;
        await redis.zadd(key, 0, missing);
        const unknown = await recovery.discover({
          organizationId: env.organization.id,
          kind: "quarantine",
          partition: fanoutPartition(missing),
        });
        expect(unknown.plan.unhandled.join(" ")).toContain("no immutable ownership record");
        expect(await redis.zscore(key, missing)).toBe("0");
        const wp = generateWaitpointId("RUN"),
          now = new Date().toISOString();
        await store.createIfAbsent({
          record: {
            id: wp,
            friendlyId: `waitpoint_${wp}`,
            type: "RUN",
            environmentId: foreign.id,
            projectId: foreignProject.id,
            createdAt: now,
            updatedAt: now,
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        await store.complete({
          waitpointId: wp,
          completion: {
            completedAt: now,
            outputType: "text/plain",
            output: null,
            outputIsError: false,
          },
        });
        const excluded = await recovery.discover({
          organizationId: env.organization.id,
          kind: "due",
          partition: fanoutPartition(wp),
        });
        expect(excluded.plan.sources.map((s) => s.waitpointId)).not.toContain(wp);
        expect(
          (
            await recovery.apply(
              {
                ...excluded.plan,
                sources: [
                  {
                    waitpointId: wp,
                    record: (await redis.hget(waitpointKeys(wp).record, "r"))!,
                    status: "COMPLETED",
                    completionId: "",
                  },
                ],
              },
              [],
              true,
              [wp]
            )
          ).errors
        ).toContainEqual({ stage: "preflight", error: expect.stringContaining("ownership") });
      } finally {
        await store.quit();
        redis.disconnect();
      }
    }
  );

  containerTest(
    "seeks by score/member under unrelated earlier-rank churn and discovers detached withdrawals after ordinary expiry",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions),
        store = new WaitpointStoreCoordinator({ client: redis });
      try {
        const key = fanoutIndexKeys(0).quarantine;
        const members = Array.from(
          { length: 220 },
          (_, i) => `source_${String(i).padStart(3, "0")}`
        );
        await redis.zadd(key, ...members.flatMap((id) => [0, id]));
        const first = (await redis.eval(READ_INDEX_PAGE, 1, key, "", "")) as string[];
        expect(first.length).toBe(200);
        await redis.zrem(key, ...members.slice(0, 75));
        await redis.zadd(key, -1, "other_org_new");
        const second = (await redis.eval(
          READ_INDEX_PAGE,
          1,
          key,
          first.at(-1)!,
          first.at(-2)!
        )) as string[];
        expect(second.filter((_, i) => i % 2 === 0)).toEqual(members.slice(100, 200));
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const runId = "lost_sql_run",
          blockId = "detached";
        await store.publishRunOwnership(runId, env.organization.id);
        const wp = generateWaitpointId("RUN"),
          now = new Date().toISOString();
        await store.createIfAbsent({
          record: {
            id: wp,
            friendlyId: `waitpoint_${wp}`,
            type: "RUN",
            environmentId: env.id,
            projectId: env.project.id,
            createdAt: now,
            updatedAt: now,
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        await store.registerBlocks({
          runId,
          blockId,
          edges: [{ waitpointId: wp, type: "RUN", createdAt: now }],
        });
        expect(await redis.hlen(waitpointKeys(wp).watchers)).toBe(1);
        await store.abandonRetainAndClear({ runId, blockId });
        await redis.unlink(runBlockKeys(runId).state);
        expect(await redis.zrange(runWithdrawalIndexKey(runId), 0, -1)).toEqual([blockId]);
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "discovery",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        const { plan } = await recovery.discover({
          organizationId: env.organization.id,
          kind: "runs",
          partition: fanoutPartition(runId),
        });
        expect(plan.entries[0]).toMatchObject({
          classification: "abandoned-registry-owned",
          blockIds: [blockId],
          eligible: true,
        });
        const result = await recovery.apply(plan, [runId], true);
        expect(result.results[0]).toMatchObject({ verified: true });
        expect(await redis.zcard(runWithdrawalIndexKey(runId))).toBe(0);
        expect(await redis.hlen(waitpointKeys(wp).watchers)).toBe(0);
        expect(await redis.hget(waitpointKeys(wp).record, "status")).toBe("PENDING");
        expect(
          await redis.zscore(
            organizationRunIndexKey(env.organization.id, fanoutPartition(runId)),
            runId
          )
        ).toBeNull();
        expect((await recovery.apply(plan, [runId], true)).errors).toContainEqual({
          stage: "preflight",
          error: expect.stringContaining("not owned"),
        });
        expect((await recovery.verify(plan)).results[0]).toMatchObject({ verified: true });
      } finally {
        await store.quit();
        redis.disconnect();
      }
    }
  );

  containerTest(
    "lost disabled fanout jobs retain reviewed sources, refuse shared watchers and replay an interrupted index cleanup",
    async ({ prisma, redisOptions }) => {
      let enabled = true;
      const redis = createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ client: redis });
      const snapshots = new RedisSnapshotStore({ redisOptions });
      const engine = makeEngine(prisma, redisOptions, {
        store,
        snapshotStore: snapshots,
        resolveDial: () => "off",
        isWaitpointStoreEnabled: async () => enabled,
      });
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const user = `source_cleanup_${randomUUID().replaceAll("-", "")}`;
      const password = randomUUID();
      const limited = createRedisClient({ ...redisOptions, username: user, password });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, ["parent-task"]);
        const run = await triggerRun(engine, env, prisma, {
          friendlyId: "run_sourcecleanup",
          taskIdentifier: "parent-task",
        });
        await dequeueAndStart(engine, "source_cleanup");
        const wp = generateWaitpointId("RUN");
        const now = new Date().toISOString();
        await store.createIfAbsent({
          record: {
            id: wp,
            friendlyId: `waitpoint_${wp}`,
            type: "RUN",
            environmentId: env.id,
            projectId: env.project.id,
            completedByTaskRunId: "child",
            createdAt: now,
            updatedAt: now,
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        const initial = (await engine.runStore.findLatestExecutionSnapshot(run.id))!;
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          organizationId: env.organization.id,
          projectId: env.project.id,
          waitpoints: [wp],
          blockOperation: {
            id: "B1",
            absorptionId: "B1",
            cycleAnchor: cycleAnchorSnapshotId(initial),
          },
        });
        await store.registerBlocks({
          runId: "other-active-parent",
          blockId: "shared",
          edges: [{ waitpointId: wp, type: "RUN", createdAt: now }],
        });
        const secondRunId = "secondselectedparent";
        const runRow = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        await prisma.taskRun.create({
          data: {
            ...runRow,
            id: secondRunId,
            friendlyId: "run_secondselectedparent",
            status: "CANCELED",
          },
        });
        await store.registerBlocks({
          runId: secondRunId,
          blockId: "second",
          edges: [{ waitpointId: wp, type: "RUN", createdAt: now }],
        });
        await store.complete({
          waitpointId: wp,
          completion: {
            completedAt: now,
            output: { inline: "retained-result" },
            outputType: "text/plain",
            outputIsError: false,
          },
        });
        enabled = false;
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const jobId = `deliverWaitpointFanout:${wp}`;
        await engine.worker.enqueue({
          id: jobId,
          job: "deliverWaitpointFanout",
          payload: { waitpointId: wp, organizationId: env.organization.id },
          availableAt: new Date(),
        });
        await expect
          .poll(() => engine.worker.getJob(jobId), { timeout: 10000, interval: 50 })
          .toBeNull();
        await engine.cancelRun({
          runId: run.id,
          organizationId: env.organization.id,
          finalizeRun: true,
        });
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "test",
          controlPlane: prisma,
          runStore,
          redis,
          store,
        });
        const plan = JSON.parse(
          JSON.stringify(
            await recovery.inspect({
              organizationId: env.organization.id,
              runs: [
                { runId: run.id, blockIds: [], sourceIds: [wp] },
                { runId: secondRunId, blockIds: [] },
              ],
            })
          )
        );
        expect(plan.entries[0].sources[0].waitpointId).toBe(wp);
        const k = waitpointKeys(wp),
          index = fanoutIndexKeys(fanoutPartition(wp));
        const before = await Promise.all(Object.values(k).map((key) => redis.dump(key)));
        const shared = await recovery.apply(plan, [run.id, secondRunId], true);
        expect(shared.results[0]?.verified).toBe(false);
        expect(shared.results[0]).toMatchObject({
          sources: [{ verified: false, disposition: "completed source cleanup outstanding" }],
        });
        expect(shared.results).toHaveLength(2);
        expect(await redis.hlen(k.watchers)).toBe(1);
        expect(await redis.hexists(k.watchers, "other-active-parent##shared")).toBe(1);
        expect(
          await Promise.all([k.record, k.queue, k.fanout].map((key) => redis.dump(key)))
        ).toEqual([before[0], before[2], before[3]]);
        expect(await redis.zscore(index.due, wp)).not.toBeNull();
        expect((await recovery.verify(plan)).results[0]?.verified).toBe(false);
        await store.unregisterWatcher({
          waitpointId: wp,
          runId: "other-active-parent",
          blockId: "shared",
        });
        // Real ACL refusal interrupts exactly between the source-slot mutation and index-slot write.
        await redis.acl(
          "SETUSER",
          user,
          "on",
          `>${password}`,
          "+@all",
          "%R~*",
          `~wp:v1:run:{${run.id}}:*`,
          `~wp:v1:{${wp}}*`
        );
        const interrupted = new ManualWaitpointRollbackRecovery({
          target: "test",
          controlPlane: prisma,
          runStore,
          redis: limited,
          store,
        });
        expect((await interrupted.apply(plan, [run.id], true)).results[0]?.verified).toBe(false);
        expect(await redis.exists(k.queue, k.watchers, k.fanout)).toBe(0);
        expect(await redis.pttl(k.record)).toBeGreaterThan(0);
        expect(JSON.parse((await redis.hget(k.record, "c"))!).output).toEqual({
          inline: "retained-result",
        });
        expect(await redis.zscore(index.due, wp)).not.toBeNull();
        expect((await recovery.verify(plan)).results[0]?.verified).toBe(false);
        await redis.acl("SETUSER", user, "resetkeys", "~*");
        const restarted = new ManualWaitpointRollbackRecovery({
          target: "test",
          controlPlane: prisma,
          runStore,
          redis: limited,
          store,
        });
        expect((await restarted.apply(plan, [run.id], true)).results[0]?.verified).toBe(true);
        expect(await redis.zscore(index.due, wp)).toBeNull();
        expect(await redis.zscore(index.quarantine, wp)).toBeNull();
        expect((await restarted.verify(plan)).results[0]?.verified).toBe(true);
        const retainedTtl = await redis.pttl(k.record);
        enabled = true;
        const duplicate = await store.complete({
          waitpointId: wp,
          completion: {
            completedAt: now,
            output: { inline: "retained-result" },
            outputType: "text/plain",
            outputIsError: false,
          },
        });
        expect(duplicate.outcome).toBe("already");
        await engine.worker.enqueue({
          id: jobId,
          job: "deliverWaitpointFanout",
          payload: { waitpointId: wp, organizationId: env.organization.id },
          availableAt: new Date(),
        });
        await expect
          .poll(() => engine.worker.getJob(jobId), { timeout: 10000, interval: 50 })
          .toBeNull();
        expect(await redis.exists(k.queue, k.watchers, k.fanout)).toBe(0);
        expect(await redis.pttl(k.record)).toBeLessThanOrEqual(retainedTtl);
        expect(JSON.parse((await redis.hget(k.record, "c"))!).output).toEqual({
          inline: "retained-result",
        });
        enabled = false;
        // Saved source identities also retire a stranded index after the source has expired.
        await redis.zadd(index.due, Date.now(), wp);
        await redis.pexpireat(k.record, 1);
        expect((await restarted.apply(plan, [run.id], true)).results[0]?.verified).toBe(true);
        expect(await redis.zscore(index.due, wp)).toBeNull();
      } finally {
        await engine.quit();
        await snapshots.quit();
        await limited.quit();
        await redis.acl("DELUSER", user);
        await redis.quit();
      }
    }
  );

  containerTest(
    "inspection is inert, scopes ownership, requires cancellation, then retains stranded terminal receipts",
    async ({ prisma, redisOptions, postgresContainer }) => {
      const redis = createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ client: redis });
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const other = await prisma.organization.create({ data: { slug: "other", title: "Other" } });
      const recovery = new ManualWaitpointRollbackRecovery({
        target: "test",
        controlPlane: prisma,
        runStore,
        redis,
        store,
      });
      const now = new Date().toISOString();
      const wp = generateWaitpointId("RUN");
      const run = await prisma.taskRun.create({
        data: {
          id: "terminal",
          friendlyId: "run_terminal",
          organizationId: env.organizationId,
          projectId: env.projectId,
          runtimeEnvironmentId: env.id,
          engine: "V2",
          status: "COMPLETED_SUCCESSFULLY",
          annotations: { waitpointsOnStore: true },
          taskIdentifier: "task",
          payload: "{}",
          payloadType: "application/json",
          traceId: "trace",
          spanId: "span",
          queue: "task/task",
        },
      });
      for (const [id, organizationId, status, waitpointsOnStore] of [
        ["pending", env.organizationId, "WAITING_TO_RESUME", true],
        ["legacy", env.organizationId, "COMPLETED_SUCCESSFULLY", false],
        ["foreign", other.id, "COMPLETED_SUCCESSFULLY", true],
      ] as const) {
        await prisma.taskRun.create({
          data: {
            ...run,
            id,
            friendlyId: `run_${id}`,
            organizationId,
            status,
            annotations: { waitpointsOnStore },
          },
        });
      }
      const record = {
        id: wp,
        friendlyId: `waitpoint_${wp}`,
        type: "RUN" as const,
        environmentId: env.id,
        projectId: env.projectId,
        createdAt: now,
        updatedAt: now,
        completedByTaskRunId: "child",
        userProvidedIdempotencyKey: false,
        tags: [],
      };
      try {
        await store.createIfAbsent({
          record,
          status: "COMPLETED",
          completion: {
            completedAt: now,
            outputType: "application/json",
            outputIsError: false,
            output: { inline: '{"value":1}' },
          },
        });
        await store.absorbBlockers({
          runId: "terminal",
          blockId: "B1",
          absorptionId: "rollback-contribution",
          edges: [{ waitpointId: wp, type: "RUN", createdAt: now }],
        });
        await store.registerBlocks({
          runId: "terminal",
          blockId: "B1",
          edges: [{ waitpointId: wp, type: "RUN", createdAt: now }],
        });
        const pending = generateWaitpointId("DATETIME");
        await store.createIfAbsent({
          record: {
            ...record,
            id: pending,
            type: "DATETIME",
            completedByTaskRunId: undefined,
            completedAfter: new Date(Date.now() + 86400000).toISOString(),
          },
          status: "PENDING",
        });
        for (const id of ["pending", "legacy", "foreign"])
          await store.registerBlocks({
            runId: id,
            blockId: "B1",
            edges: [{ waitpointId: pending, type: "DATETIME", createdAt: now }],
          });
        const keys = [
          ...Object.values(runBlockKeys("terminal")),
          runResultKey("terminal"),
          runContributionIndexKey("terminal"),
          ...Object.values(runBlockKeys("pending")),
          runContributionIndexKey("pending"),
          ...Object.values(runBlockKeys("legacy")),
          runContributionIndexKey("legacy"),
          ...Object.values(runBlockKeys("foreign")),
          runContributionIndexKey("foreign"),
        ];
        const before = await Promise.all(keys.map((key) => redis.dump(key)));
        const plan = await recovery.inspect({
          organizationId: env.organizationId,
          runs: ["terminal", "pending", "legacy", "foreign", "missing"].map((runId) => ({
            runId,
            blockIds: [],
          })),
        });
        expect(await Promise.all(keys.map((key) => redis.dump(key)))).toEqual(before);
        expect(await prisma.taskRun.findUniqueOrThrow({ where: { id: "terminal" } })).toEqual(run);
        expect(plan.entries.map((entry) => entry.classification)).toEqual([
          "terminal",
          "pending",
          "legacy",
          "unknown",
          "unknown",
        ]);
        expect(plan.unhandled.join(" ")).toContain(
          "Sources absent from this run scope require organization source registry"
        );
        expect((await recovery.apply(plan, ["foreign"], true)).errors).toContainEqual({
          stage: "preflight",
          error: expect.stringContaining("not owned"),
        });
        expect((await recovery.apply(plan, ["legacy"], true)).errors).toContainEqual({
          stage: "preflight",
          error: expect.stringContaining("not owned"),
        });
        expect((await recovery.apply(plan, ["pending"], true)).errors).toContainEqual({
          stage: "preflight",
          error: expect.stringContaining("cancellation"),
        });
        expect(await redis.pttl(runResultKey("terminal"))).toBe(-1);
        expect(await redis.pttl(runBlockKeys("terminal").done)).toBe(-1);
        const result = await recovery.apply(plan, ["terminal"], true);
        expect(result.results[0]?.verified).toBe(true);
        expect(
          await redis.exists(
            runContributionIndexKey("terminal"),
            runContributionKey("terminal", "B1", "rollback-contribution")
          )
        ).toBe(0);
        const ttl = await redis.pttl(runResultKey("terminal"));
        expect(ttl).toBeGreaterThan(0);
        expect(await redis.exists(runBlockKeys("terminal").done)).toBe(0);
        expect(
          (await store.readCompletedRecords([wp], "terminal")).get(wp)?.completion?.output
        ).toEqual({ inline: '{"value":1}' });
        expect((await recovery.apply(plan, ["terminal"], true)).results[0]?.verified).toBe(true);
        expect(await redis.pttl(runResultKey("terminal"))).toBeLessThanOrEqual(ttl);
        expect(await Promise.all(keys.slice(11).map((key) => redis.dump(key)))).toEqual(
          before.slice(11)
        );
        expect((await recovery.verify(plan)).results[0]?.verified).toBe(true);
        // Results-only: all block keys are absent while immutable snapshot results remain.
        await prisma.taskRun.create({
          data: { ...run, id: "results_only", friendlyId: "run_results_only" },
        });
        await store.registerBlocks({
          runId: "results_only",
          blockId: "results-block",
          edges: [{ waitpointId: wp, type: "RUN", createdAt: now }],
        });
        await store.acknowledgeResumeHandoff({ runId: "results_only", blockId: "results-block" });
        await store.clearBlockState({ runId: "results_only", blockId: "results-block" });
        await redis.del(...Object.values(runBlockKeys("results_only")));
        expect(await redis.pttl(runResultKey("results_only"))).toBe(-1);
        const resultsOnly = await recovery.inspect({
          organizationId: env.organizationId,
          runs: [{ runId: "results_only", blockIds: [] }],
        });
        expect(
          (await recovery.apply(resultsOnly, ["results_only"], true)).results[0]?.verified
        ).toBe(true);
        expect(await redis.pttl(runResultKey("results_only"))).toBeGreaterThan(0);
        await prisma.organization.update({
          where: { id: env.organizationId },
          data: { featureFlags: { waitpointStoreEnabled: true } },
        });
        const contributionsOnly = await recovery.inspect(
          {
            organizationId: env.organizationId,
            runs: ["terminal", "pending", "foreign", "missing"].map((runId) => ({
              runId,
              blockIds: [],
            })),
          },
          "contributions-only"
        );
        for (const runId of ["pending", "foreign", "missing"]) {
          expect((await recovery.apply(contributionsOnly, [runId], true)).errors).toContainEqual({
            stage: "preflight",
            error: expect.stringContaining("not owned"),
          });
        }
        // Smoke the actual operator entry against fixture services; it must exit without server/worker boot.
        const directory = await mkdtemp(join(tmpdir(), "waitpoint-rollback-cli-"));
        try {
          const config = join(directory, "topology.json"),
            scope = join(directory, "scope.json"),
            out = join(directory, "plan.json");
          await writeFile(
            config,
            JSON.stringify({
              deployment: "test",
              controlPlaneUrlEnv: "ROLLBACK_TEST_DB",
              redisUrlEnv: "ROLLBACK_TEST_REDIS",
              redisCluster: false,
              runStores: {
                mode: "routed",
                legacyUrlEnv: "ROLLBACK_TEST_DB",
                newUrlEnv: "ROLLBACK_TEST_DB",
                shards: [{ key: "a", aliasOf: "new" }],
              },
            })
          );
          await writeFile(
            scope,
            JSON.stringify({
              organizationId: env.organizationId,
              runs: [{ runId: "results_only", blockIds: [] }],
            })
          );
          for (const operation of ["rollback", "contributions-only"] as const) {
            await prisma.organization.update({
              where: { id: env.organizationId },
              data: { featureFlags: { waitpointStoreEnabled: operation === "contributions-only" } },
            });
            const operationOut = `${out}.${operation}`;
            await promisify(execFile)(
              fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url)),
              [
                fileURLToPath(
                  new URL("../../../harness/waitpointRollbackRecovery.ts", import.meta.url)
                ),
                "--config",
                config,
                "--scope",
                scope,
                "--operation",
                operation,
                "--out",
                operationOut,
              ],
              {
                timeout: 20_000,
                env: {
                  ...process.env,
                  NODE_OPTIONS: "--conditions=@triggerdotdev/source",
                  ROLLBACK_TEST_DB: postgresContainer.getConnectionUri(),
                  ROLLBACK_TEST_REDIS: `redis://:${encodeURIComponent(redisOptions.password ?? "")}@${redisOptions.host}:${redisOptions.port}`,
                },
              }
            );
            const cliPlan = JSON.parse(await readFile(operationOut, "utf8"));
            expect(cliPlan.entries[0].classification).toBe("terminal");
            expect(cliPlan.operation).toBe(operation);
            expect(cliPlan.unhandled.join(" ")).toContain(
              "Sources absent from this run scope require organization source registry"
            );
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "finalizes terminal retention after a supplied historical block was already abandoned",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ client: redis });
      const adapter = new StoreWaitpointCoordinator({ store });
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const runId = "finalized-historical-block";
      const blockId = "previous-attempt";
      const wp = generateWaitpointId("DATETIME");
      const now = new Date().toISOString();
      try {
        await store.createIfAbsent({
          record: {
            id: wp,
            friendlyId: `waitpoint_${wp}`,
            type: "DATETIME",
            environmentId: env.id,
            projectId: env.project.id,
            createdAt: now,
            updatedAt: now,
            completedAfter: new Date(Date.now() + 86400000).toISOString(),
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        await store.registerBlocks({
          runId,
          blockId,
          edges: [{ waitpointId: wp, type: "DATETIME", createdAt: now }],
        });
        await store.armCleanupFence({ runId, blockId });
        await adapter.abandonRunBlockers({ runId, blockId });
        expect(await redis.hmget(runBlockKeys(runId).state, "blk", "co", "term")).toEqual([
          null,
          null,
          null,
        ]);
        expect(await redis.pttl(runBlockKeys(runId).state)).toBe(-1);
        expect(await redis.zcard(runWithdrawalIndexKey(runId))).toBe(0);
        expect(await redis.exists(runWithdrawalKey(runId, blockId), runResultKey(runId))).toBe(0);
        expect(await redis.hlen(waitpointKeys(wp).watchers)).toBe(0);
        await prisma.taskRun.create({
          data: {
            id: runId,
            friendlyId: `run_${runId}`,
            organizationId: env.organizationId,
            projectId: env.projectId,
            runtimeEnvironmentId: env.id,
            engine: "V2",
            status: "COMPLETED_WITH_ERRORS",
            annotations: { waitpointsOnStore: true },
            taskIdentifier: "task",
            payload: "{}",
            payloadType: "application/json",
            traceId: "trace",
            spanId: "span",
            queue: "task/task",
          },
        });
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "historical",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        const plan = await recovery.inspect({
          organizationId: env.organizationId,
          runs: [{ runId, blockIds: [blockId] }],
        });
        // Contribution-only maintenance still leaves nonterminal native retention untouched.
        expect(
          (await recovery.apply({ ...plan, operation: "contributions-only" }, [runId], true))
            .results[0]?.verified
        ).toBe(true);
        expect(await redis.pttl(runBlockKeys(runId).state)).toBe(-1);
        const sourceBefore = await redis.dump(waitpointKeys(wp).record);
        const result = await recovery.apply(plan, [runId], true);
        expect(result.errors).toEqual([]);
        expect(result.results[0]?.verified).toBe(true);
        expect(await redis.hget(runBlockKeys(runId).state, "term")).toBe("1");
        const ttl = await redis.pttl(runBlockKeys(runId).state);
        expect(ttl).toBeGreaterThan(0);
        expect(await redis.dump(waitpointKeys(wp).record)).toEqual(sourceBefore);
        expect((await recovery.apply(plan, [runId], true)).results[0]?.verified).toBe(true);
        expect(await redis.pttl(runBlockKeys(runId).state)).toBeLessThanOrEqual(ttl);
        expect((await recovery.verify(plan)).results[0]?.verified).toBe(true);
      } finally {
        await store.quit();
        redis.disconnect();
      }
    }
  );

  containerTest(
    "a lost withdrawal attempt retains its exact block and converges on manual rerun",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const user = `rollback_${randomUUID().replaceAll("-", "")}`;
      const runId = "partial";
      const restricted = createRedisClient({
        ...redisOptions,
        username: user,
        password: "test-password",
      });
      const store = new WaitpointStoreCoordinator({ client: redis });
      const limitedStore = new WaitpointStoreCoordinator({ client: restricted });
      const recovery = new ManualWaitpointRollbackRecovery({
        target: "test",
        controlPlane: prisma,
        runStore,
        redis: restricted,
        store: limitedStore,
      });
      const wp = generateWaitpointId("RUN");
      const now = new Date().toISOString();
      try {
        await prisma.taskRun.create({
          data: {
            id: runId,
            friendlyId: `run_${runId}`,
            organizationId: env.organizationId,
            projectId: env.projectId,
            runtimeEnvironmentId: env.id,
            engine: "V2",
            status: "CANCELED",
            annotations: { waitpointsOnStore: true },
            taskIdentifier: "task",
            payload: "{}",
            payloadType: "application/json",
            traceId: "trace",
            spanId: "span",
            queue: "task/task",
          },
        });
        await store.createIfAbsent({
          record: {
            id: wp,
            friendlyId: `waitpoint_${wp}`,
            type: "RUN",
            environmentId: env.id,
            projectId: env.projectId,
            createdAt: now,
            updatedAt: now,
            completedByTaskRunId: "child",
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        await store.registerBlocks({
          runId,
          blockId: "old-block",
          edges: [{ waitpointId: wp, type: "RUN", createdAt: now }],
        });
        await redis.acl(
          "SETUSER",
          user,
          "on",
          ">test-password",
          "+@all",
          `~wp:v1:run:{${runId}}:*`,
          "~wp:v1:org:*",
          `%R~wp:v1:{${wp}}*`,
          "%R~wp:v1:f*"
        );
        // A prior lifecycle attempt detached the historical targets before inspection.
        await store.terminalRetainAndClear({ runId, blockId: "old-block" });
        const incomplete = await recovery.inspect({
          organizationId: env.organizationId,
          runs: [{ runId, blockIds: ["old-block"] }],
        });
        expect(incomplete.entries[0]?.sources.map((source) => source.waitpointId)).toEqual([wp]);
        const unreviewed = await recovery.apply(incomplete, [runId], true);
        expect(unreviewed.results[0]).toMatchObject({
          verified: false,
          error: expect.stringMatching(/permission|NOPERM|ACL/i),
        });
        expect(await redis.hlen(waitpointKeys(wp).watchers)).toBe(1);
        expect(await redis.hlen(`${runWithdrawalKey(runId, "old-block")}:edges`)).toBe(1);
        const plan = await recovery.inspect({
          organizationId: env.organizationId,
          runs: [{ runId, blockIds: ["old-block"], sourceIds: [wp] }],
        });
        const failed = await recovery.apply(plan, [runId], true);
        expect(failed.results[0]?.verified).toBe(false);
        expect(await redis.hget(runBlockKeys(runId).state, "term")).toBe("1");
        expect(await redis.get(runWithdrawalKey(runId, "old-block"))).toBe("old-block");
        expect(await redis.pttl(runWithdrawalKey(runId, "old-block"))).toBe(-1);
        await redis.acl("SETUSER", user, `~wp:v1:{${wp}}*`);
        expect((await recovery.apply(plan, [runId], true)).results[0]?.verified).toBe(true);
        expect(await redis.exists(runWithdrawalKey(runId, "old-block"))).toBe(0);
        expect(await redis.hlen(waitpointKeys(wp).watchers)).toBe(0);
        expect((await recovery.apply(plan, [runId], true)).results[0]?.verified).toBe(true);
      } finally {
        await restricted.quit();
        await redis.acl("DELUSER", user);
        await redis.quit();
      }
    }
  );

  containerTest(
    "stale plans, changed cycles and re-enabled organizations are refused before mutation",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const store = new WaitpointStoreCoordinator({ client: redis });
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const recovery = new ManualWaitpointRollbackRecovery({
        target: "test",
        controlPlane: prisma,
        runStore,
        redis,
        store,
      });
      const runId = "stale";
      try {
        await prisma.taskRun.create({
          data: {
            id: runId,
            friendlyId: `run_${runId}`,
            organizationId: env.organizationId,
            projectId: env.projectId,
            runtimeEnvironmentId: env.id,
            engine: "V2",
            status: "CANCELED",
            annotations: { waitpointsOnStore: true },
            taskIdentifier: "task",
            payload: "{}",
            payloadType: "application/json",
            traceId: "trace",
            spanId: "span",
            queue: "task/task",
          },
        });
        await store.absorbBlockers({ runId, blockId: "B1", edges: [] });
        const plan = await recovery.inspect({
          organizationId: env.organizationId,
          runs: [{ runId, blockIds: [] }],
        });
        const expired = await recovery.apply(
          { ...plan, expiresAt: new Date(0).toISOString() },
          [runId],
          true
        );
        expect(expired.results).toEqual([]);
        expect(expired.errors).toEqual([
          { stage: "preflight", error: expect.stringContaining("expired") },
        ]);
        expect((await recovery.apply(plan, [runId], false)).errors).toContainEqual({
          stage: "preflight",
          error: expect.stringContaining("maintenance"),
        });
        await prisma.organization.update({
          where: { id: env.organizationId },
          data: { featureFlags: { waitpointStoreEnabled: true } },
        });
        expect((await recovery.apply(plan, [runId], true)).errors).toContainEqual({
          stage: "preflight",
          error: expect.stringContaining("enabled"),
        });
        await prisma.organization.update({
          where: { id: env.organizationId },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        await store.absorbBlockers({
          runId,
          blockId: "B2",
          expectedPreviousBlockId: "B1",
          edges: [],
        });
        const dump = await redis.dump(runBlockKeys(runId).state);
        expect((await recovery.apply(plan, [runId], true)).errors).toContainEqual({
          stage: "preflight",
          error: expect.stringContaining("cycle"),
        });
        // The exact-state CAS is inside the destructive script, covering rollover after preflight.
        await expect(
          store.releaseRunWatchers({
            runId,
            blockId: "B1",
            reason: "terminal",
            expectedRollbackState: plan.entries[0]!.native!.identity,
          })
        ).rejects.toThrow("changed");
        await expect(
          store.cleanupRunBlockState({
            runId,
            reason: "terminal",
            expectedRollbackState: plan.entries[0]!.native!.identity,
          })
        ).rejects.toThrow("changed");
        expect(await redis.dump(runBlockKeys(runId).state)).toEqual(dump);
        await prisma.organization.update({
          where: { id: env.organizationId },
          data: { featureFlags: { waitpointStoreEnabled: true } },
        });
        const contributionPlan = { ...plan, operation: "contributions-only" as const };
        expect((await recovery.apply(contributionPlan, [runId], true)).errors).toContainEqual({
          stage: "preflight",
          error: expect.stringContaining("cycle"),
        });
        expect(
          (
            await recovery.apply(
              { ...contributionPlan, expiresAt: new Date(0).toISOString() },
              [runId],
              true
            )
          ).errors
        ).toContainEqual({ stage: "preflight", error: expect.stringContaining("expired") });
        await prisma.taskRun.update({ where: { id: runId }, data: { status: "EXECUTING" } });
        expect((await recovery.apply(contributionPlan, [runId], true)).errors).toContainEqual({
          stage: "preflight",
          error: expect.stringContaining("cancellation"),
        });
        expect(await redis.dump(runBlockKeys(runId).state)).toEqual(dump);
      } finally {
        await redis.quit();
      }
    }
  );
  containerTest(
    "indexed contributions retire after re-enable without touching a stale native cycle, including partial rerun",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions);
      const user = `contributions_${randomUUID().replaceAll("-", "")}`;
      const password = randomUUID();
      await redis.call("ACL", "SETUSER", user, "on", `>${password}`, "+@all", "~*");
      const limited = createRedisClient({ ...redisOptions, username: user, password });
      const store = new WaitpointStoreCoordinator({ client: redis });
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const runId = "lost-contributions";
      const heldSource = generateWaitpointId("DATETIME");
      const index = runContributionIndexKey(runId);
      const contributions = Array.from({ length: 130 }, (_, i) =>
        runContributionKey(runId, "B1", `A${String(i).padStart(3, "0")}`)
      );
      const recovery = new ManualWaitpointRollbackRecovery({
        target: "test",
        controlPlane: prisma,
        runStore,
        redis: limited,
        store,
      });
      try {
        await prisma.taskRun.create({
          data: {
            id: runId,
            friendlyId: `run_${runId}`,
            organizationId: env.organizationId,
            projectId: env.projectId,
            runtimeEnvironmentId: env.id,
            engine: "V2",
            status: "CANCELED",
            annotations: { waitpointsOnStore: true },
            taskIdentifier: "task",
            payload: "{}",
            payloadType: "application/json",
            traceId: "trace",
            spanId: "span",
            queue: "task/task",
          },
        });
        await store.createIfAbsent({
          record: {
            id: heldSource,
            friendlyId: `waitpoint_${heldSource}`,
            type: "DATETIME",
            environmentId: env.id,
            projectId: env.projectId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            tags: [],
            userProvidedIdempotencyKey: false,
          },
          status: "PENDING",
        });
        for (let i = 0; i < contributions.length; i++) {
          if (i === 129)
            await store.prepareRegistrationSources({
              runId,
              blockId: "B1",
              absorptionId: "A129",
              waitpointIds: [heldSource],
              evidence: "!request:test",
            });
          // Model process death after real absorption, before registration. No surviving job or
          // caller-supplied absorption identity is available to the recovery service.
          await store.absorbBlockers({
            runId,
            blockId: "B1",
            absorptionId: `A${String(i).padStart(3, "0")}`,
            registrationEvidence: i === 129 ? "!request:test" : undefined,
            edges: [
              {
                waitpointId: i === 129 ? heldSource : `missing-source-${i}`,
                type: "RUN",
                createdAt: new Date().toISOString(),
              },
            ],
          });
        }
        await recovery.inspect({
          organizationId: env.organizationId,
          runs: [{ runId, blockIds: [] }],
        });
        await prisma.organization.update({
          where: { id: env.organizationId },
          data: { featureFlags: { waitpointStoreEnabled: true } },
        });
        const plan = await recovery.inspect(
          {
            organizationId: env.organizationId,
            runs: [{ runId, blockIds: [] }],
          },
          "contributions-only"
        );
        const stateBefore = await redis.dump(runBlockKeys(runId).state);
        await expect(
          recovery.inspect({ organizationId: env.organizationId, runs: [{ runId, blockIds: [] }] })
        ).rejects.toThrow("enabled");
        expect(plan.entries[0]!.native!.keys.find((k) => k.name === "contributions")!.count).toBe(
          130
        );
        expect(await redis.pttl(index)).toBe(-1);
        // Only the first bounded page is writable. Redis itself refuses the next page, leaving its
        // identities discoverable independently of this process and the ordinary tombstone TTL.
        await redis.call(
          "ACL",
          "SETUSER",
          user,
          "resetkeys",
          "%R~*",
          ...[
            ...Object.values(runBlockKeys(runId)),
            runResultKey(runId),
            runWithdrawalKey(runId, "B1"),
            `${runWithdrawalKey(runId, "B1")}:edges`,
          ].map((key) => `~${key}`),
          `~${index}`,
          ...contributions.slice(0, 128).map((key) => `~${key}`)
        );
        const partial = await recovery.apply(plan, [runId], true);
        expect(partial.results[0]!.verified).toBe(false);
        expect("error" in partial.results[0]! && partial.results[0]!.error).toMatch(
          /NOPERM|permission|ACL/
        );
        expect(await redis.zcard(index)).toBe(2);
        expect(await redis.dump(runBlockKeys(runId).state)).toEqual(stateBefore);
        expect(await redis.exists(contributions[0]!)).toBe(0);
        expect(await redis.exists(contributions[129]!)).toBe(1);
        await redis.call("ACL", "SETUSER", user, "resetkeys", "~*");
        // Deterministically expire ordinary native keys, as after prolonged inactivity.
        // The index and contribution records deliberately keep their identities without TTL.
        for (const key of Object.values(runBlockKeys(runId))) {
          await redis.pexpireat(key, 1);
        }
        expect(await redis.exists(runBlockKeys(runId).state)).toBe(0);
        const restarted = new ManualWaitpointRollbackRecovery({
          target: "test",
          controlPlane: prisma,
          runStore,
          redis: limited,
          store,
        });
        const resumedPlan = await restarted.inspect(
          {
            organizationId: env.organizationId,
            runs: [{ runId, blockIds: [] }],
          },
          "contributions-only"
        );
        expect((await restarted.apply(resumedPlan, [runId], true)).results[0]!.verified).toBe(true);
        expect(await redis.exists(index, ...contributions)).toBe(0);
        expect(await redis.hget(waitpointKeys(heldSource).record, "rh")).toBeNull();
        expect(await redis.exists(runBlockKeys(runId).state)).toBe(0);
        expect((await restarted.verify(resumedPlan)).results[0]!.verified).toBe(true);
      } finally {
        await limited.quit();
        await redis.call("ACL", "DELUSER", user);
        await redis.quit();
      }
    }
  );

  // Catches: source-only apply arming a finite TTL on a completed source an unselected parent still holds (rh > 0).
  containerTest(
    "source-only apply keeps a completed DATETIME held by an unselected parent's prepared registration",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions),
        store = new WaitpointStoreCoordinator({ client: redis });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "held",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        const wp = generateWaitpointId("DATETIME"),
          now = new Date().toISOString(),
          parent = { runId: "unselected-parent", blockId: "B1", absorptionId: "A1" };
        const record = waitpointKeys(wp).record,
          related = waitpointRelatedRunsKey(wp),
          index = fanoutIndexKeys(fanoutPartition(wp));
        await store.createIfAbsent({
          record: {
            id: wp,
            friendlyId: `waitpoint_${wp}`,
            type: "DATETIME",
            environmentId: env.id,
            projectId: env.project.id,
            completedAfter: new Date(Date.now() - 1000).toISOString(),
            createdAt: now,
            updatedAt: now,
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        // Related-run history from an earlier, withdrawn watcher: zero live watchers remain.
        await store.registerOrReport({
          waitpointId: wp,
          runId: "historical-watcher",
          blockId: "H1",
          createdAt: now,
        });
        await store.unregisterWatcher({
          waitpointId: wp,
          runId: "historical-watcher",
          blockId: "H1",
        });
        // The parent prepared its registration (rh=1) but has not absorbed. It is never selected.
        await store.prepareRegistrationSources({
          ...parent,
          waitpointIds: [wp],
          evidence: "!request:held",
        });
        await store.complete({
          waitpointId: wp,
          completion: {
            completedAt: now,
            outputType: "application/json",
            output: null,
            outputIsError: false,
          },
        });
        await redis.zadd(index.due, Date.now() + 86400000, wp);
        expect(await redis.hget(record, "rh")).toBe("1");
        expect(await redis.hlen(waitpointKeys(wp).watchers)).toBe(0);
        expect(await redis.pttl(record)).toBe(-1);
        expect(await redis.pttl(related)).toBe(-1);

        const { plan } = await recovery.discover({
          organizationId: env.organization.id,
          kind: "due",
          partition: fanoutPartition(wp),
        });
        expect(plan.sources.find((s) => s.waitpointId === wp)?.status).toBe("COMPLETED");
        const before = await redis.dump(record);
        const result = await recovery.apply(plan, [], true, [wp]);
        // No retention armed and nothing retired while the unselected parent still holds it.
        expect(await redis.pttl(record)).toBe(-1);
        expect(await redis.pttl(related)).toBe(-1);
        expect(await redis.zrange(related, 0, -1)).toEqual(["historical-watcher"]);
        expect(await redis.dump(record)).toEqual(before);
        expect(await redis.zscore(index.due, wp)).not.toBeNull();
        expect(result.errors).toEqual([]);
        const held = {
          waitpointId: wp,
          verified: false,
          registrationHold: true,
          disposition: expect.any(String),
        };
        expect(result.sources).toEqual([held]);
        expect((await recovery.verify(plan)).sources).toEqual([held]);
        // The parent can still absorb it.
        expect((await store.readCompletedRecords([wp], parent.runId)).get(wp)?.status).toBe(
          "COMPLETED"
        );

        // A finite TTL armed under a hold (as the unfixed tool did) never verifies as retained.
        await redis.zrem(index.due, wp);
        const expiresAt = Date.now() + 3600000;
        await redis.pexpireat(record, expiresAt);
        await redis.pexpireat(related, expiresAt);
        expect((await recovery.verify(plan)).sources).toEqual([held]);

        // The holding parent's contribution cleanup releases the hold; a rerun then converges.
        await store.releaseRegistrationSources(parent);
        expect(await redis.hget(record, "rh")).toBeNull();
        const rerun = await recovery.apply(plan, [], true, [wp]);
        expect(rerun.errors).toEqual([]);
        expect(rerun.sources).toEqual([{ waitpointId: wp, verified: true }]);
      } finally {
        await store.quit();
        redis.disconnect();
      }
    }
  );

  // Catches: completing a held elapsed DATETIME and then arming its retention before the parent absorbs.
  containerTest(
    "a held elapsed DATETIME completes without retention and converges after release",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions),
        store = new WaitpointStoreCoordinator({ client: redis });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "held-datetime",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        const wp = generateWaitpointId("DATETIME"),
          now = new Date().toISOString(),
          record = waitpointKeys(wp).record,
          parent = { runId: "unselected-parent", blockId: "B1", absorptionId: "A1" };
        await store.publishPendingSource(wp, env.organization.id);
        await store.createIfAbsent({
          record: {
            id: wp,
            friendlyId: `waitpoint_${wp}`,
            type: "DATETIME",
            environmentId: env.id,
            organizationId: env.organization.id,
            projectId: env.project.id,
            completedAfter: new Date(Date.now() - 60_000).toISOString(),
            createdAt: now,
            updatedAt: now,
            userProvidedIdempotencyKey: false,
            tags: [],
          },
          status: "PENDING",
        });
        await store.prepareRegistrationSources({
          ...parent,
          waitpointIds: [wp],
          evidence: "!request:held",
        });
        const { plan } = await recovery.discover({
          organizationId: env.organization.id,
          kind: "pending-sources",
          partition: fanoutPartition(wp),
        });
        expect(plan.sources).toMatchObject([{ waitpointId: wp, status: "PENDING" }]);
        const result = await recovery.apply(plan, [], true, [wp]);
        expect(result.errors).toEqual([]);
        expect(result.sources).toEqual([
          {
            waitpointId: wp,
            verified: false,
            registrationHold: true,
            disposition: expect.any(String),
          },
        ]);
        expect(await redis.hget(record, "status")).toBe("COMPLETED");
        expect(await redis.pttl(record)).toBe(-1);
        expect(
          await redis.zscore(
            organizationPendingSourceIndexKey(env.organization.id, fanoutPartition(wp)),
            wp
          )
        ).not.toBeNull();
        expect(
          (await store.readCompletedRecords([wp], parent.runId)).get(wp)?.completion
        ).toMatchObject({ output: null, outputIsError: false });

        await store.releaseRegistrationSources(parent);
        expect(await redis.pttl(record)).toBeGreaterThan(0);
        const rerun = await recovery.apply(plan, [], true, [wp]);
        expect(rerun.errors).toEqual([]);
        expect(rerun.sources).toEqual([{ waitpointId: wp, verified: true }]);
      } finally {
        await store.quit();
        redis.disconnect();
      }
    }
  );

  // Catches: a held keyed DATETIME (ka keeps PTTL -1) counting as retained, so the hold goes unreported.
  containerTest(
    "a held tracked keyed DATETIME reports its registration hold and converges after release",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions),
        store = new WaitpointStoreCoordinator({ client: redis });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "held-keyed",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        const wp = generateWaitpointId("DATETIME"),
          now = new Date().toISOString(),
          record = waitpointKeys(wp).record,
          acceptUntil = Date.now() + 60_000,
          receiptKey = idempotencyReceiptKey(env.id, "held-key", wp),
          pendingIndex = organizationPendingSourceIndexKey(
            env.organization.id,
            fanoutPartition(wp)
          ),
          parent = { runId: "unselected-parent", blockId: "B1", absorptionId: "A1" };
        await store.publishPendingSource(wp, env.organization.id, { key: receiptKey, acceptUntil });
        await store.createWithIdempotencyKey({
          record: {
            id: wp,
            friendlyId: `waitpoint_${wp}`,
            type: "DATETIME",
            environmentId: env.id,
            organizationId: env.organization.id,
            projectId: env.project.id,
            completedAfter: new Date(Date.now() - 60_000).toISOString(),
            createdAt: now,
            updatedAt: now,
            userProvidedIdempotencyKey: true,
            idempotencyKey: "held-key",
            idempotencyKeyExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
            tags: [],
          },
          environmentId: env.id,
          idempotencyKey: "held-key",
          acceptUntil,
        });
        await store.prepareRegistrationSources({
          ...parent,
          waitpointIds: [wp],
          evidence: "!request:held",
        });
        expect(await redis.hget(record, "ka")).toBe("1");
        const { plan } = await recovery.discover({
          organizationId: env.organization.id,
          kind: "pending-sources",
          partition: fanoutPartition(wp),
        });
        expect(plan.sources).toMatchObject([{ waitpointId: wp, status: "PENDING" }]);

        const result = await recovery.apply(plan, [], true, [wp]);
        const held = {
          waitpointId: wp,
          verified: false,
          registrationHold: true,
          disposition: expect.stringContaining("registration hold remains"),
        };
        expect(result.errors).toEqual([]);
        expect(result.sources).toEqual([held]);
        expect((await recovery.verify(plan)).sources).toEqual([held]);
        expect(await redis.hget(record, "rh")).toBe("1");
        expect(await redis.hget(record, "ka")).toBe("1");
        expect(await redis.pttl(record)).toBe(-1);
        expect(await redis.pttl(receiptKey)).toBe(-1);
        expect(await redis.zscore(pendingIndex, wp)).not.toBeNull();

        // Release applies ordinary retention, which keeps a keyed record permanent.
        await store.releaseRegistrationSources(parent);
        expect(await redis.hget(record, "ka")).toBe("1");
        expect(await redis.pttl(record)).toBe(-1);
        const rerun = await recovery.apply(plan, [], true, [wp]);
        expect(rerun.errors).toEqual([]);
        expect(rerun.sources).toEqual([{ waitpointId: wp, verified: true }]);
        expect(await redis.hget(record, "ka")).toBeNull();
        expect(await redis.pttl(record)).toBeGreaterThan(0);
        expect(await redis.pttl(receiptKey)).toBeGreaterThan(0);
      } finally {
        await store.quit();
        redis.disconnect();
      }
    }
  );

  // Catches: a held keyed DATETIME with a non-expiring key (ku -1) counting as retained, so the hold goes unreported.
  containerTest(
    "a held keyed DATETIME whose key never expires reports its registration hold",
    async ({ prisma, redisOptions }) => {
      const redis = createRedisClient(redisOptions),
        store = new WaitpointStoreCoordinator({ client: redis });
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: env.organization.id },
          data: { featureFlags: { waitpointStoreEnabled: false } },
        });
        const recovery = new ManualWaitpointRollbackRecovery({
          target: "held-permanent-key",
          controlPlane: prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          redis,
          store,
        });
        const wp = generateWaitpointId("DATETIME"),
          now = new Date().toISOString(),
          record = waitpointKeys(wp).record,
          acceptUntil = Date.now() + 60_000,
          receiptKey = idempotencyReceiptKey(env.id, "permanent-key", wp),
          pendingIndex = organizationPendingSourceIndexKey(
            env.organization.id,
            fanoutPartition(wp)
          ),
          receiptIndex = organizationSourceReceiptKey(env.organization.id, fanoutPartition(wp)),
          parent = { runId: "unselected-parent", blockId: "B1", absorptionId: "A1" };
        await store.publishPendingSource(wp, env.organization.id, { key: receiptKey, acceptUntil });
        // No idempotencyKeyExpiresAt: the reservation is permanent, so creation writes ku = -1.
        await store.createWithIdempotencyKey({
          record: {
            id: wp,
            friendlyId: `waitpoint_${wp}`,
            type: "DATETIME",
            environmentId: env.id,
            organizationId: env.organization.id,
            projectId: env.project.id,
            completedAfter: new Date(Date.now() - 60_000).toISOString(),
            createdAt: now,
            updatedAt: now,
            userProvidedIdempotencyKey: true,
            idempotencyKey: "permanent-key",
            tags: [],
          },
          environmentId: env.id,
          idempotencyKey: "permanent-key",
          acceptUntil,
        });
        await store.prepareRegistrationSources({
          ...parent,
          waitpointIds: [wp],
          evidence: "!request:held",
        });
        expect(await redis.hget(record, "ku")).toBe("-1");
        expect(await redis.hget(record, "rh")).toBe("1");
        const { plan } = await recovery.discover({
          organizationId: env.organization.id,
          kind: "pending-sources",
          partition: fanoutPartition(wp),
        });
        expect(plan.sources).toMatchObject([{ waitpointId: wp, status: "PENDING" }]);

        const result = await recovery.apply(plan, [], true, [wp]);
        const held = {
          waitpointId: wp,
          verified: false,
          registrationHold: true,
          disposition: expect.stringContaining("registration hold remains"),
        };
        expect(result.errors).toEqual([]);
        expect(result.sources).toEqual([held]);
        expect((await recovery.verify(plan)).sources).toEqual([held]);
        expect(await redis.hget(record, "rh")).toBe("1");
        expect(await redis.pttl(record)).toBe(-1);
        expect(await redis.pttl(receiptKey)).toBe(-1);
        expect(await redis.zscore(pendingIndex, wp)).not.toBeNull();
        expect(await redis.hexists(receiptIndex, wp)).toBe(1);

        await store.releaseRegistrationSources(parent);
        expect(await redis.hget(record, "rh")).toBeNull();
        const rerun = await recovery.apply(plan, [], true, [wp]);
        expect(rerun.errors).toEqual([]);
        expect(rerun.sources).toEqual([{ waitpointId: wp, verified: true }]);
        // The reservation is permanent, so the converged record keeps no TTL.
        expect(await redis.pttl(record)).toBe(-1);
        expect(await redis.zscore(pendingIndex, wp)).toBeNull();
        expect(await redis.hexists(receiptIndex, wp)).toBe(0);
        expect(await redis.pttl(receiptKey)).toBeGreaterThan(0);
      } finally {
        await store.quit();
        redis.disconnect();
      }
    }
  );
});
