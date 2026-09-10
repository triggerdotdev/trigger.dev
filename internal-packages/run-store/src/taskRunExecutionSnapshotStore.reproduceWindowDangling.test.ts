// PR #82 convergence: a redis-primary read-since window whose head points at a DANGLING completed-waitpoint
// cycle (its cycle key aged out) must FAIL CLOSED. Returning a row with an empty completedWaitpointOrder
// would silently drop the runner's completed results and can hang it — an empty order there means
// "unknown", not "none". A genuine no-cycle head still returns an empty order successfully. Real Redis +
// Postgres (testcontainers), no mocks; the dangling state is produced by deleting the real cycle key.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore, type CompletedWaitpointResolver } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  SnapshotReadUnavailableError,
} from "./taskRunExecutionSnapshotStore.js";
import { snapshotKeys } from "./snapshotKeys.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";

const resolver: CompletedWaitpointResolver = async ({ records }) =>
  records.map((r) => ({
    id: r.id,
    friendlyId: r.friendlyId,
    type: r.type,
    completedAt: new Date(r.completedAt),
    completedByTaskRunId: r.completedByTaskRunId ?? null,
    completedByBatchId: r.completedByBatchId ?? null,
    completedAfter: r.completedAfter ? new Date(r.completedAfter) : null,
    outputType: r.outputType,
    outputIsError: r.outputIsError,
    output: r.output && "inline" in r.output ? r.output.inline : null,
    idempotencyKey: r.idempotencyKey ?? "",
    userProvidedIdempotencyKey: r.idempotencyKey !== undefined,
    inactiveIdempotencyKey: null,
  }));

function birthSnapshot(env: Awaited<ReturnType<typeof seedSnapshotEnvironment>>, id: string) {
  return {
    id,
    createdAt: new Date(),
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "Run was created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

describe("#reproduceWindow dangling completed-waitpoint cycle (PR #82)", () => {
  containerTest(
    "fails closed when the window head's cycle key is gone, instead of returning an empty order",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();
        const waitpointId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });

        // Window cursor: after the birth, before the transition, so the window's head IS the transition.
        const cursor = new Date();
        await writer.createExecutionSnapshot({
          id: transitionId,
          createdAt: new Date(cursor.getTime() + 1000),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "Waitpoint completed" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
          completedWaitpoints: [{ id: waitpointId, index: 0 }],
          resolveCompletedWaitpointRecords: async () => [
            {
              id: waitpointId,
              friendlyId: "waitpoint_ok",
              type: "MANUAL",
              completedAt: "2026-01-01T00:00:00.000Z",
              outputType: "application/json",
              outputIsError: false,
              output: { inline: "42" },
            },
          ],
        });

        // Fault injection: delete the REAL cycle key the head points at, leaving a dangling pointer.
        const head = await store.getLatest(runId);
        const cycleSeq = (head as unknown as { cycle?: { cycleSeq: number } }).cycle?.cycleSeq;
        expect(cycleSeq).toBeTypeOf("number");
        const base = snapshotKeys(runId).e.slice(0, -2); // strip trailing ":e"
        await raw.del(`${base}:wp:${cycleSeq}`);

        // The production decorator's read-since window must reject, NOT return an empty-order row.
        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: resolver,
        });
        await expect(
          reader.findManyExecutionSnapshots({
            where: { runId, createdAt: { gt: cursor } },
            include: { checkpoint: true },
            orderBy: { createdAt: "desc" },
            take: 50,
          })
        ).rejects.toThrow(SnapshotReadUnavailableError);
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );

  containerTest(
    "a genuine no-cycle head still returns an empty completedWaitpointOrder successfully",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const transitionId = generateInternalId();

        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        const cursor = new Date();
        await writer.createExecutionSnapshot({
          id: transitionId,
          createdAt: new Date(cursor.getTime() + 1000),
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "Run started" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
          // No completedWaitpoints: this head carries no cycle at all.
        });

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
          resolveCompletedWaitpoints: resolver,
        });
        const rows = await reader.findManyExecutionSnapshots({
          where: { runId, createdAt: { gt: cursor } },
          include: { checkpoint: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0].id).toBe(transitionId);
        expect(rows[0].completedWaitpointOrder).toEqual([]);
      } finally {
        await store.quit();
      }
    }
  );
});
