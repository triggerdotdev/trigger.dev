// F2: a transaction must NOT report success unless its Redis unit was applied. A finalize that
// published nothing (baseMissing / an unproven stale/noop) fails closed and retriable, leaving the
// pending unit to recovery. Real Postgres + Redis; the base is evicted via the existing beforeFinalize
// seam to induce a genuine baseMissing (no store mocking).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore, type CompletedWaitpointRecord } from "./redisSnapshotStore.js";
import {
  SnapshotWriteUnavailableError,
  TaskRunExecutionSnapshotStore,
} from "./taskRunExecutionSnapshotStore.js";
import { SnapshotResidencyResolver } from "./snapshotResidencyResolver.js";
import { snapshotKeys } from "./snapshotKeys.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";

function birthSnapshot(env: Awaited<ReturnType<typeof seedSnapshotEnvironment>>, id: string) {
  return {
    id,
    createdAt: new Date(),
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

describe("runInTransaction fails closed when the Redis unit is not published (F2)", () => {
  containerTest(
    "a finalize that finds the base gone throws retriable unavailability, never success",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      const runId = generateInternalId();
      let armed = false;
      const decorator = new TaskRunExecutionSnapshotStore(delegate, {
        store,
        mode: "redis-only",
        resolveDial: () => "redis-only",
        residencyResolver: new SnapshotResidencyResolver({
          store,
          taskRunExists: async (id: string) => (await prisma.taskRun.count({ where: { id } })) > 0,
        }),
        logicalRunStoreRoute: ROUTE,
        // Evict the base AFTER prepare, BEFORE finalize, only on the armed transition: the real finalize
        // then returns baseMissing.
        hooks: {
          beforeFinalize: async () => {
            if (armed) await raw.del(snapshotKeys(runId).seq);
          },
        },
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const birthId = generateInternalId();
        await decorator.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // The transition prepares against the live head, then the hook evicts the base before finalize.
        armed = true;
        const transitionId = generateInternalId();
        await expect(
          decorator.createExecutionSnapshot({
            id: transitionId,
            createdAt: new Date(),
            run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
            snapshot: { executionStatus: "EXECUTING", description: "started" },
            previousSnapshotId: birthId,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          })
        ).rejects.toThrow(SnapshotWriteUnavailableError);

        // Nothing advanced: the transition entry was never published as the head.
        expect(await store.getById(runId, transitionId)).toBeNull();
      } finally {
        await raw.quit().catch(() => undefined);
        await store.quit();
      }
    }
  );

  // A `noop` finalize (a lost-reply repeat: the unit was already applied out of band) reports SUCCESS
  // only after read-back proves every staged entry — raw AND its completed-waitpoint cycle — is the
  // committed state. Here the out-of-band finalize applies the real unit, so the repeat is a genuine
  // noop whose entries reproduce exactly, and the transaction must resolve, not fail closed.
  containerTest(
    "a noop finalize whose staged entries are already applied reports success",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const runId = generateInternalId();
      let armed = false;
      let lastToken = "";
      const decorator = new TaskRunExecutionSnapshotStore(delegate, {
        store,
        mode: "redis-only",
        resolveDial: () => "redis-only",
        residencyResolver: new SnapshotResidencyResolver({
          store,
          taskRunExists: async (id: string) => (await prisma.taskRun.count({ where: { id } })) > 0,
        }),
        logicalRunStoreRoute: ROUTE,
        generateTransitionToken: () => {
          lastToken = generateInternalId();
          return lastToken;
        },
        // Apply the unit out of band on the armed transition, so the real finalize is a genuine noop.
        hooks: {
          beforeFinalize: async () => {
            if (armed) await store.finalize(runId, lastToken);
          },
        },
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const birthId = generateInternalId();
        await decorator.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        const rec: CompletedWaitpointRecord = {
          id: "W",
          friendlyId: "waitpoint_W",
          type: "RUN",
          completedAt: "2026-01-01T00:00:00.000Z",
          outputType: "application/json",
          outputIsError: false,
          output: { inline: "W" },
        };
        armed = true;
        const transitionId = generateInternalId();
        await decorator.createExecutionSnapshot({
          id: transitionId,
          createdAt: new Date(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING_WITH_WAITPOINTS", description: "waited" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
          completedWaitpoints: [{ id: "W", index: 0 }],
          resolveCompletedWaitpointRecords: async () => [rec],
        });

        // The out-of-band finalize published the head; the noop transaction accepted it as success.
        expect((await store.getLatest(runId))?.id).toBe(transitionId);
        const cw = await store.getSnapshotCompletedWaitpoints(runId, transitionId);
        expect(cw.present).toBe(true);
        expect(cw.order).toEqual(["W"]);
        expect(cw.records.map((r) => r.id)).toEqual(["W"]);
      } finally {
        await store.quit();
      }
    }
  );

  // The conflict: a noop finalize whose committed entry under the staged id has DIFFERENT bytes is not
  // proof — the same id carrying different contents means our unit was never the committed state. The
  // read-back's exact raw comparison must reject it and the transaction must fail closed.
  containerTest(
    "a noop finalize whose committed entry differs from the staged raw fails closed",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      const runId = generateInternalId();
      let armed = false;
      let lastToken = "";
      let corruptId = "";
      const decorator = new TaskRunExecutionSnapshotStore(delegate, {
        store,
        mode: "redis-only",
        resolveDial: () => "redis-only",
        residencyResolver: new SnapshotResidencyResolver({
          store,
          taskRunExists: async (id: string) => (await prisma.taskRun.count({ where: { id } })) > 0,
        }),
        logicalRunStoreRoute: ROUTE,
        generateTransitionToken: () => {
          lastToken = generateInternalId();
          return lastToken;
        },
        // Apply the unit out of band (making the real finalize a noop), then corrupt the committed
        // entry so its stored raw no longer matches what this transaction staged under that id. Both
        // happen here, before the real finalize + read-back, so the ordering is deterministic.
        hooks: {
          beforeFinalize: async () => {
            if (!armed) return;
            await store.finalize(runId, lastToken);
            await raw.hset(
              snapshotKeys(runId).e,
              corruptId,
              JSON.stringify({ id: corruptId, corrupted: true })
            );
          },
        },
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const birthId = generateInternalId();
        await decorator.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        armed = true;
        const transitionId = generateInternalId();
        corruptId = transitionId;

        await expect(
          decorator.createExecutionSnapshot({
            id: transitionId,
            createdAt: new Date(),
            run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
            snapshot: { executionStatus: "EXECUTING", description: "started" },
            previousSnapshotId: birthId,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          })
        ).rejects.toThrow(SnapshotWriteUnavailableError);
      } finally {
        await raw.quit().catch(() => undefined);
        await store.quit();
      }
    }
  );

  // Carry-forward conflict: a noop finalize whose reproduced completed-waitpoint cycle has DIFFERENT
  // records than what the carry-forward staged is not proof. #stagedCycleReproduces must compare records
  // (not just presence), so a corrupted cycle fails closed rather than advancing the head.
  containerTest(
    "a noop carry-forward finalize whose reproduced cycle records differ fails closed",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      const runId = generateInternalId();
      let armed = false;
      let lastToken = "";
      let headCycleSeq = 0;
      const cycleKey = (seq: number) => `${snapshotKeys(runId).e.slice(0, -2)}:wp:${seq}`;
      const decorator = new TaskRunExecutionSnapshotStore(delegate, {
        store,
        mode: "redis-only",
        resolveDial: () => "redis-only",
        residencyResolver: new SnapshotResidencyResolver({
          store,
          taskRunExists: async (id: string) => (await prisma.taskRun.count({ where: { id } })) > 0,
        }),
        logicalRunStoreRoute: ROUTE,
        generateTransitionToken: () => {
          lastToken = generateInternalId();
          return lastToken;
        },
        // On the armed carry-forward: apply it out of band (real finalize becomes a noop), then corrupt
        // the pointed cycle's records so the read-back proof sees a cycle that is NOT what we staged.
        hooks: {
          beforeFinalize: async () => {
            if (!armed) return;
            await store.finalize(runId, lastToken);
            await raw.hset(
              cycleKey(headCycleSeq),
              "records",
              JSON.stringify([{ id: "W", tampered: true }])
            );
          },
        },
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const birthId = generateInternalId();
        await decorator.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        const rec: CompletedWaitpointRecord = {
          id: "W",
          friendlyId: "waitpoint_W",
          type: "RUN",
          completedAt: "2026-01-01T00:00:00.000Z",
          outputType: "application/json",
          outputIsError: false,
          output: { inline: "W" },
        };
        // Head cycle (new, with a real record) that the carry-forward will point at.
        const t1 = generateInternalId();
        await decorator.createExecutionSnapshot({
          id: t1,
          createdAt: new Date(),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING_WITH_WAITPOINTS", description: "waited" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
          completedWaitpoints: [{ id: "W", index: 0 }],
          resolveCompletedWaitpointRecords: async () => [rec],
        });
        headCycleSeq = (await store.getLatest(runId))?.cycle?.cycleSeq ?? 0;
        expect(headCycleSeq).toBeGreaterThan(0);

        // A carry-forward transition (same waitpoints, NO resolver): its noop finalize must fail closed
        // because the pointed cycle's records were tampered.
        armed = true;
        const t2 = generateInternalId();
        await expect(
          decorator.createExecutionSnapshot({
            id: t2,
            createdAt: new Date(),
            run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
            snapshot: { executionStatus: "EXECUTING_WITH_WAITPOINTS", description: "carried" },
            previousSnapshotId: t1,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
            completedWaitpoints: [{ id: "W", index: 0 }],
          })
        ).rejects.toThrow(SnapshotWriteUnavailableError);
      } finally {
        await raw.quit().catch(() => undefined);
        await store.quit();
      }
    }
  );
});
