import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
// Exercise this checkout's store source, not declaration-only refreshed dist from an older build.
import {
  PostgresRunStore,
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
} from "../../../../run-store/src/index.js";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
} from "../../../../run-store/src/testFixtures/snapshotIdFixture.js";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";

// Count actual Postgres snapshot queries, not substituted responses or a fake engine.
class CountingPostgresStore extends PostgresRunStore {
  latestReads = 0;
  override findLatestExecutionSnapshot(
    ...args: Parameters<PostgresRunStore["findLatestExecutionSnapshot"]>
  ) {
    this.latestReads++;
    return super.findLatestExecutionSnapshot(...args);
  }
}

containerTest(
  "existing server organization context survives waitpoint block/resume and snapshot polling",
  async ({ prisma, redisOptions }) => {
    const env = await seedSnapshotEnvironment(prisma);
    const runId = generateInternalId();
    const birthId = generateInternalId();
    const postgres = new CountingPostgresStore({ prisma, readOnlyPrisma: prisma });
    const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const store = new TaskRunExecutionSnapshotStore(postgres, {
      store: redis,
      mode: "redis-only",
      logicalRunStoreRoute: "single",
      resolveCompletedWaitpoints: createCompletedWaitpointResolver(postgres),
    });
    const engine = new RunEngine({
      prisma,
      store,
      worker: { redis: redisOptions, disabled: true },
      queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
      runLock: { redis: redisOptions },
      machines: {
        defaultMachine: "small-1x",
        machines: { "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
        baseCostInCents: 0.0001,
      },
      tracer: trace.getTracer("snapshot-organization-context"),
    });
    try {
      await store.createRun({
        data: { ...buildCreateRunData(runId, env), status: "EXECUTING", attemptNumber: 1 },
        snapshot: {
          id: birthId,
          engine: "V2",
          executionStatus: "EXECUTING",
          description: "Executing fixture",
          runStatus: "EXECUTING",
          attemptNumber: 1,
          environmentId: env.id,
          environmentType: env.type,
          organizationId: env.organizationId,
          projectId: env.projectId,
        },
      });
      // This method already reads the run; the snapshot read must reuse its organization.
      await engine.waitpointSystem.getOrCreateRunWaitpoint({
        runId,
        projectId: env.projectId,
        environmentId: env.id,
      });
      const { waitpoint } = await engine.createManualWaitpoint({
        environmentId: env.id,
        projectId: env.projectId,
      });
      const blocked = await engine.blockRunWithWaitpoint({
        runId,
        waitpoints: waitpoint.id,
        projectId: env.projectId,
        organizationId: env.organizationId,
      });
      expect(blocked.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
      await engine.completeWaitpoint({ id: waitpoint.id, output: { value: "done" } });
      expect((await engine.waitpointSystem.continueRunIfUnblocked({ runId })).status).toBe(
        "unblocked"
      );
      const result = await engine.getRunExecutionData({
        runId,
        organizationId: env.organizationId,
      });
      expect(result?.snapshot.executionStatus).toBe("EXECUTING");
      expect(result?.completedWaitpoints.map((w) => w.id)).toContain(waitpoint.id);
      const since = await engine.getSnapshotsSince({
        runId,
        snapshotId: blocked.id,
        organizationId: env.organizationId,
      });
      expect(since?.[0].snapshot.id).toBe(result?.snapshot.id);
      expect(since?.[0].completedWaitpoints.map((w) => w.id)).toContain(waitpoint.id);
      expect(
        postgres.latestReads,
        "known organization must not require an identity-discovery snapshot query"
      ).toBe(0);
      expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
    } finally {
      await engine.quit();
      await redis.quit();
    }
  }
);
