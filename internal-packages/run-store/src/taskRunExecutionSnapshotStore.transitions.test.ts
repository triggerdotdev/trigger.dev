// A transition writes Postgres first and Redis second. The order is proved by observation, not by
// reading the code: with the Redis half made to fail, the Postgres row is still there and the caller
// sees no error, which is only possible if Postgres went first.
import { describe, expect } from "vitest";
import { postgresAndRedisTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { entryFromCreateRun } from "./snapshotEntry.js";
import { InjectedSnapshotFault } from "./snapshotFaultInjection.js";
import {
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreMode,
} from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  seedSnapshotWorker,
  setupSnapshotIdFixture,
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

type Harness = {
  decorated: TaskRunExecutionSnapshotStore;
  redis: RedisSnapshotStore;
  repairs: { runId: string; snapshotId: string; executionStatus: string }[];
  writes: { site: string; outcome: string }[];
};

function harness(
  prisma: never,
  redisOptions: never,
  opts?: {
    mode?: SnapshotStoreMode;
    faults?: ConstructorParameters<typeof TaskRunExecutionSnapshotStore>[1]["faults"];
  }
): Harness {
  const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
  const repairs: Harness["repairs"] = [];
  const writes: Harness["writes"] = [];

  const decorated = new TaskRunExecutionSnapshotStore(
    new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) as unknown as RunStore,
    {
      store: redis,
      mode: opts?.mode ?? "dual-write",
      ...(opts?.faults && { faults: opts.faults }),
      onAppendFailure: async (args) => {
        repairs.push(args);
      },
      metrics: {
        recordWrite: (site, outcome) => writes.push({ site, outcome }),
        recordAppendFailed: () => {},
        recordRead: () => {},
      },
    }
  );

  return { decorated, redis, repairs, writes };
}

/**
 * Creates the run and its keyspace, so a following transition is not skippedNoKeyspace.
 *
 * The birth is appended through the raw store rather than the decorator, because the decorator's
 * own birth path is a separate concern with its own suite. Keeping it out here means a failure in
 * this file is a failure of the transition path and nothing else.
 */
async function seedBirth(
  decorated: TaskRunExecutionSnapshotStore,
  redis: RedisSnapshotStore,
  runId: string,
  env: SnapshotFixtureEnv
): Promise<void> {
  const snapshot = {
    id: generateInternalId(),
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "Run was created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };

  await redis.append({
    entry: entryFromCreateRun({ id: snapshot.id, runId, createdAt: new Date() }, snapshot),
    kind: "birth",
    isTerminal: false,
  });

  await decorated.createRun({ data: buildCreateRunData(runId, env), snapshot });
}

function completionInput(env: SnapshotFixtureEnv) {
  return {
    completedAt: new Date(),
    outputType: "application/json",
    usageDurationMs: 1,
    costInCents: 0,
    snapshot: {
      executionStatus: "FINISHED" as const,
      description: "Run completed",
      runStatus: "COMPLETED_SUCCESSFULLY" as const,
      attemptNumber: 1,
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    },
  };
}

function expireInput(env: SnapshotFixtureEnv) {
  return {
    error: { type: "STRING_ERROR" as const, raw: "expired" },
    completedAt: new Date(),
    expiredAt: new Date(),
    snapshot: {
      engine: "V2" as const,
      executionStatus: "FINISHED" as const,
      description: "Run expired",
      runStatus: "EXPIRED" as const,
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    },
  };
}

describe("transition write ordering", () => {
  postgresAndRedisTest("writes Postgres then Redis", async ({ prisma, redisOptions }) => {
    const { decorated, redis, writes } = harness(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      await seedBirth(decorated, redis, runId, env);

      await decorated.completeAttemptSuccess(runId, completionInput(env), { select: { id: true } });

      const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({
        where: { runId, executionStatus: "FINISHED" },
      });
      const read = await redis.getById(runId, row.id);

      expect(read).not.toBeNull();
      expect(read!.entry.id).toBe(row.id);
      expect(read!.entry.executionStatus).toBe("FINISHED");
      expect(writes).toContainEqual({ site: "completeAttemptSuccess", outcome: "written" });
    } finally {
      await redis.quit();
    }
  });

  postgresAndRedisTest(
    "keeps the Postgres write and enqueues one repair when the append fails",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis, repairs } = harness(prisma as never, redisOptions as never, {
        faults: (boundary) => {
          if (boundary === "afterPgBeforeRedis") throw new InjectedSnapshotFault(boundary);
        },
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await seedBirth(decorated, redis, runId, env);

        // The caller must NOT see an error: the Postgres mutation already committed, and the stall
        // watchdog is the designed compensator.
        await decorated.completeAttemptSuccess(runId, completionInput(env), {
          select: { id: true },
        });

        const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({
          where: { runId, executionStatus: "FINISHED" },
        });

        expect(await redis.getById(runId, row.id)).toBeNull();
        expect(repairs).toEqual([
          { runId, snapshotId: row.id, executionStatus: "FINISHED" },
        ]);
      } finally {
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest(
    "treats a transition on a run with no keyspace as skipped, not failed",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis, repairs, writes } = harness(prisma as never, redisOptions as never);
      try {
        // No birth: this is every pre-cutover run's first transition after the dial moves.
        const { run, env } = await setupSnapshotIdFixture(prisma);

        await decorated.expireRun(run.id, expireInput(env), { select: { id: true } });

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(1);
        expect(await redis.getLatest(run.id)).toBeNull();
        expect(repairs).toEqual([]);
        expect(writes).toEqual([{ site: "expireRun", outcome: "skippedNoKeyspace" }]);
      } finally {
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest("appends for expireRun", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = harness(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      await seedBirth(decorated, redis, runId, env);

      await decorated.expireRun(runId, expireInput(env), { select: { id: true } });

      const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({
        where: { runId, executionStatus: "FINISHED" },
      });
      const read = await redis.getById(runId, row.id);
      expect(read?.entry.description).toBe("Run expired");
    } finally {
      await redis.quit();
    }
  });

  postgresAndRedisTest("appends for expireParkedRun", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = harness(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      await seedBirth(decorated, redis, runId, env);
      await prisma.taskRun.update({ where: { id: runId }, data: { status: "PENDING_VERSION" } });

      const result = await decorated.expireParkedRun(runId, {
        ...expireInput(env),
        statusReason: "VERSION_NEVER_ARRIVED",
        snapshot: { ...expireInput(env).snapshot, description: "Parked run expired" },
      });

      expect(result.count).toBe(1);
      const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({
        where: { runId, executionStatus: "FINISHED" },
      });
      expect((await redis.getById(runId, row.id))?.entry.description).toBe("Parked run expired");
    } finally {
      await redis.quit();
    }
  });

  postgresAndRedisTest(
    "appends nothing when expireParkedRun matches no run",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis, writes } = harness(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await seedBirth(decorated, redis, runId, env);
        // The run is PENDING, so the delegate's `status: PENDING_VERSION` guard matches nothing.

        const result = await decorated.expireParkedRun(runId, {
          ...expireInput(env),
          statusReason: "VERSION_NEVER_ARRIVED",
        });

        expect(result.count).toBe(0);
        expect(writes.filter((w) => w.site === "expireParkedRun")).toEqual([]);
        const latest = await redis.getLatest(runId);
        expect(latest?.entry.executionStatus).toBe("RUN_CREATED");
      } finally {
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest("appends for rescheduleRun", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = harness(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      await seedBirth(decorated, redis, runId, env);

      await decorated.rescheduleRun(runId, {
        delayUntil: new Date(Date.now() + 60_000),
        snapshot: {
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        },
      });

      const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({
        where: { runId, executionStatus: "DELAYED" },
      });
      expect((await redis.getById(runId, row.id))?.entry.description).toBe(
        "Delayed run was rescheduled to a future date"
      );
    } finally {
      await redis.quit();
    }
  });

  postgresAndRedisTest(
    "appends nothing when rescheduleRun carries no snapshot",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis, writes } = harness(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await seedBirth(decorated, redis, runId, env);

        await decorated.rescheduleRun(runId, { delayUntil: new Date(Date.now() + 60_000) });

        expect(writes.filter((w) => w.site === "rescheduleRun")).toEqual([]);
        expect((await redis.getLatest(runId))?.entry.executionStatus).toBe("RUN_CREATED");
      } finally {
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest("appends for lockRunToWorker under a CAS", async ({ prisma, redisOptions }) => {
    const { decorated, redis, writes } = harness(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const { workerId, taskId } = await seedSnapshotWorker(prisma, env);
      const runId = generateInternalId();
      await seedBirth(decorated, redis, runId, env);

      const head = await redis.getLatest(runId);
      const snapshotId = generateInternalId();

      await decorated.lockRunToWorker(runId, {
        lockedAt: new Date(),
        lockedById: taskId,
        lockedToVersionId: workerId,
        lockedQueueId: undefined,
        startedAt: new Date(),
        baseCostInCents: 0,
        machinePreset: "small-1x",
        taskVersion: "1.0.0",
        snapshot: {
          id: snapshotId,
          previousSnapshotId: head!.id,
          attemptNumber: 1,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
          completedWaitpointIds: [],
          completedWaitpointOrder: [],
        },
      });

      const read = await redis.getById(runId, snapshotId);
      expect(read?.entry.executionStatus).toBe("PENDING_EXECUTING");
      expect(read?.entry.previousSnapshotId).toBe(head!.id);
      expect(writes).toContainEqual({ site: "lockRunToWorker", outcome: "written" });
    } finally {
      await redis.quit();
    }
  });

  postgresAndRedisTest(
    "reports a forked append without enqueuing a repair",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis, repairs, writes } = harness(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const { workerId, taskId } = await seedSnapshotWorker(prisma, env);
        const runId = generateInternalId();
        await seedBirth(decorated, redis, runId, env);

        // A stale previousSnapshotId: another writer advanced the head. A repair cannot help, so the
        // outcome is counted and dropped.
        await decorated.lockRunToWorker(runId, {
          lockedAt: new Date(),
          lockedById: taskId,
          lockedToVersionId: workerId,
          lockedQueueId: undefined,
          startedAt: new Date(),
          baseCostInCents: 0,
          machinePreset: "small-1x",
          taskVersion: "1.0.0",
          snapshot: {
            id: generateInternalId(),
            previousSnapshotId: generateInternalId(),
            attemptNumber: 1,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
            completedWaitpointIds: [],
            completedWaitpointOrder: [],
          },
        });

        expect(writes).toContainEqual({ site: "lockRunToWorker", outcome: "forked" });
        expect(repairs).toEqual([]);
      } finally {
        await redis.quit();
      }
    }
  );

  postgresAndRedisTest("appends for the standalone createExecutionSnapshot", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = harness(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      await seedBirth(decorated, redis, runId, env);

      const created = await decorated.createExecutionSnapshot({
        run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "Run started" },
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      });

      const read = await redis.getById(runId, created.id);
      expect(read).not.toBeNull();
      expect(read!.entry.executionStatus).toBe("EXECUTING");
      // The standalone path is the one whose delegate returns the row, so both stores agree exactly.
      expect(read!.entry.createdAt).toBe(created.createdAt.toISOString());
    } finally {
      await redis.quit();
    }
  });

  postgresAndRedisTest("writes nothing to Redis at mode off", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = harness(prisma as never, redisOptions as never, { mode: "off" });
    try {
      const { run, env } = await setupSnapshotIdFixture(prisma);

      await decorated.completeAttemptSuccess(run.id, completionInput(env), {
        select: { id: true },
      });

      expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(1);
      expect(await redis.getLatest(run.id)).toBeNull();
    } finally {
      await redis.quit();
    }
  });
});
