import { containerTestWithIsolatedRedis as containerTest } from "@internal/testcontainers";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
  SnapshotResidencyResolver,
  type CompletedWaitpointRecord,
} from "@internal/run-store";
import { generateInternalId, generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { routingEngine } from "./utils/waitpointRouting.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
} from "../../../../run-store/src/testFixtures/snapshotIdFixture.js";

type Resolver = {
  resolveResumeCompletedWaitpointRecords(
    runId: string,
    blockers: { waitpoint: { id: string } }[],
    organizationId: string
  ): Promise<CompletedWaitpointRecord[]>;
};

describe("waitpoint rollout snapshots", () => {
  containerTest(
    "Redis-primary TRES retains the original Postgres resolver when waitpoints are disabled",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const snapshots = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const waitpoints = new WaitpointStoreCoordinator({ redisOptions });
      // A real, closed waitpoint connection: disabled organisations must not depend on its availability.
      await waitpoints.quit();
      const writer = new TaskRunExecutionSnapshotStore(delegate, {
        store: snapshots,
        mode: "redis-only",
        resolveDial: () => "redis-only",
        logicalRunStoreRoute: "rollout-test",
        residencyResolver: new SnapshotResidencyResolver({
          store: snapshots,
        }),
      });
      const instance = routingEngine(prisma, redisOptions, {
        store: writer,
        waitpointStore: waitpoints,
        waitpointStoreEnabled: () => false,
      });
      const system = instance.waitpointSystem as unknown as Resolver;
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: {
            id: birthId,
            createdAt: new Date(),
            engine: "V2",
            executionStatus: "RUN_CREATED",
            description: "created",
            runStatus: "PENDING",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
        });
        const ids: string[] = [];
        for (const type of ["RUN", "BATCH", "MANUAL", "DATETIME"] as const) {
          const row = await prisma.waitpoint.create({
            data: {
              friendlyId: `waitpoint_${generateInternalId()}`,
              type,
              status: "COMPLETED",
              completedAt: new Date(),
              output: JSON.stringify(type),
              outputType: "application/json",
              idempotencyKey: generateInternalId(),
              userProvidedIdempotencyKey: false,
              projectId: env.projectId,
              environmentId: env.id,
            },
          });
          ids.push(row.id);
        }
        // Disabled resolution keeps the original Postgres query and ignores IDs with no row.
        const disabledRecords = await system.resolveResumeCompletedWaitpointRecords(
          runId,
          [...ids, generateWaitpointId("RUN")].map((id) => ({ waitpoint: { id } })),
          env.organizationId
        );
        expect(disabledRecords.map((record) => record.id).sort()).toEqual([...ids].sort());
        for (const record of disabledRecords) {
          expect(record.output).toEqual({ inline: JSON.stringify(record.type) });
        }
        const completedWaitpoints = [...ids, ids[0]!].map((id, index) => ({ id, index }));
        const transitionId = generateInternalId();
        await writer.createExecutionSnapshot({
          id: transitionId,
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "resumed" },
          previousSnapshotId: birthId,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
          completedWaitpoints,
          resolveCompletedWaitpointRecords: () =>
            system.resolveResumeCompletedWaitpointRecords(
              runId,
              completedWaitpoints.map((w) => ({ waitpoint: { id: w.id } })),
              env.organizationId
            ),
        });
        const cycle = await snapshots.getSnapshotCompletedWaitpoints(runId, transitionId);
        expect(cycle.present).toBe(true);
        expect(cycle.records.map((r) => r.id).sort()).toEqual([...ids].sort());
        expect(cycle.order).toEqual(completedWaitpoints.map((w) => w.id));
        expect(await prisma.waitpoint.count()).toBe(4);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { id: transitionId } })).toBe(
          0
        );
      } finally {
        await instance.quit();
        await snapshots.quit();
      }
    }
  );
});
