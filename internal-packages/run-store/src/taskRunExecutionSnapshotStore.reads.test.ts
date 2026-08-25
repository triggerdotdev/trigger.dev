// Reads served from Redis must be indistinguishable from the Postgres reads they replace: the same
// payload shape, the same tenant boundary, the same fallback when Redis does not hold the answer.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreMode,
} from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

function build(
  prisma: never,
  redisOptions: never,
  opts?: { mode?: SnapshotStoreMode; readPercent?: number }
) {
  const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
  const reads: { method: string; source: string }[] = [];

  const decorated = new TaskRunExecutionSnapshotStore(
    new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) as unknown as RunStore,
    {
      store: redis,
      mode: opts?.mode ?? "redis-read",
      readPercent: opts?.readPercent ?? 100,
      metrics: {
        recordWrite: () => {},
        recordAppendFailed: () => {},
        recordRead: (method, source) => reads.push({ method, source }),
      },
    }
  );

  return { decorated, redis, reads };
}

async function seedRun(
  decorated: TaskRunExecutionSnapshotStore,
  env: SnapshotFixtureEnv
): Promise<string> {
  const runId = generateInternalId();
  await decorated.createRun({
    data: buildCreateRunData(runId, env),
    snapshot: {
      id: generateInternalId(),
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
    },
  });
  return runId;
}

function snapshotInput(runId: string, env: SnapshotFixtureEnv, description: string) {
  return {
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING" as const, description },
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

describe("snapshot reads", () => {
  containerTest("serves the latest snapshot from Redis", async ({ prisma, redisOptions }) => {
    const { decorated, redis, reads } = build(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = await seedRun(decorated, env);
      const created = await decorated.createExecutionSnapshot(
        snapshotInput(runId, env, "Run started")
      );

      const latest = await decorated.findLatestExecutionSnapshot(runId);

      expect(latest).not.toBeNull();
      expect(latest!.id).toBe(created.id);
      expect(latest!.executionStatus).toBe("EXECUTING");
      expect(latest!.description).toBe("Run started");
      expect(latest!.runId).toBe(runId);
      expect(latest!.checkpoint).toBeNull();
      expect(latest!.completedWaitpoints).toEqual([]);
      expect(reads).toContainEqual({ method: "findLatestExecutionSnapshot", source: "redis" });
    } finally {
      await redis.quit();
    }
  });

  containerTest("returns the same payload Postgres would", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = build(prisma as never, redisOptions as never);
    const postgresOnly = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = await seedRun(decorated, env);
      await decorated.createExecutionSnapshot(snapshotInput(runId, env, "Run started"));

      const fromRedis = await decorated.findLatestExecutionSnapshot(runId);
      const fromPostgres = await postgresOnly.findLatestExecutionSnapshot(runId);

      expect(fromRedis!.id).toBe(fromPostgres!.id);
      expect(fromRedis!.executionStatus).toBe(fromPostgres!.executionStatus);
      expect(fromRedis!.description).toBe(fromPostgres!.description);
      expect(fromRedis!.runStatus).toBe(fromPostgres!.runStatus);
      expect(fromRedis!.attemptNumber).toBe(fromPostgres!.attemptNumber);
      expect(fromRedis!.isValid).toBe(fromPostgres!.isValid);
      expect(fromRedis!.environmentId).toBe(fromPostgres!.environmentId);
      expect(fromRedis!.createdAt.toISOString()).toBe(fromPostgres!.createdAt.toISOString());
    } finally {
      await redis.quit();
    }
  });

  containerTest(
    "returns the same field set Postgres does, key for key",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      const postgresOnly = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, env);
        await decorated.createExecutionSnapshot(snapshotInput(runId, env, "Run started"));

        const fromRedis = await decorated.findLatestExecutionSnapshot(runId);
        const fromPostgres = await postgresOnly.findLatestExecutionSnapshot(runId);

        // Not a value comparison: a column the hydrator forgets is absent rather than wrong, so it
        // shows up as a missing KEY. lastHeartbeatAt was omitted this way and read back undefined
        // where Postgres returns null, on every Redis-served read.
        expect(Object.keys(fromRedis!).sort()).toEqual(Object.keys(fromPostgres!).sort());
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "reads a foreign environment as not found, so the caller's 404 still fires",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, env);
        await decorated.createExecutionSnapshot(snapshotInput(runId, env, "Run started"));

        const foreign = await decorated.findLatestExecutionSnapshot(runId, undefined, "env_other");

        expect(foreign).toBeNull();
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "falls back to Postgres for a run with no keyspace",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis, reads } = build(prisma as never, redisOptions as never);
      const postgresOnly = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        // A pre-cutover run: it exists in Postgres and Redis has never seen it.
        await postgresOnly.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: {
            id: generateInternalId(),
            engine: "V2",
            executionStatus: "RUN_CREATED",
            description: "Run was created",
            runStatus: "PENDING",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
        });

        const latest = await decorated.findLatestExecutionSnapshot(runId);

        expect(latest).not.toBeNull();
        expect(latest!.executionStatus).toBe("RUN_CREATED");
        expect(reads).toContainEqual({ method: "findLatestExecutionSnapshot", source: "postgres" });
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest("reads from Postgres at readPercent 0", async ({ prisma, redisOptions }) => {
    const { decorated, redis, reads } = build(prisma as never, redisOptions as never, {
      readPercent: 0,
    });
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = await seedRun(decorated, env);

      const latest = await decorated.findLatestExecutionSnapshot(runId);

      expect(latest).not.toBeNull();
      expect(reads).toEqual([]);
    } finally {
      await redis.quit();
    }
  });

  containerTest("reads from Postgres at mode dual-write", async ({ prisma, redisOptions }) => {
    const { decorated, redis, reads } = build(prisma as never, redisOptions as never, {
      mode: "dual-write",
    });
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = await seedRun(decorated, env);

      const latest = await decorated.findLatestExecutionSnapshot(runId);

      expect(latest).not.toBeNull();
      expect(reads).toEqual([]);
    } finally {
      await redis.quit();
    }
  });

  containerTest("serves the since-cursor lookup from Redis", async ({ prisma, redisOptions }) => {
    const { decorated, redis, reads } = build(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = await seedRun(decorated, env);
      const created = await decorated.createExecutionSnapshot(
        snapshotInput(runId, env, "Run started")
      );

      const cursor = await decorated.findExecutionSnapshot({
        where: { id: created.id, runId },
        select: { createdAt: true },
      });

      expect(cursor).not.toBeNull();
      expect((cursor as { createdAt: Date }).createdAt.toISOString()).toBe(
        created.createdAt.toISOString()
      );
      expect(reads).toContainEqual({ method: "findExecutionSnapshot", source: "redis" });
    } finally {
      await redis.quit();
    }
  });

  containerTest(
    "delegates a snapshot lookup it does not recognise",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis, reads } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, env);
        const created = await decorated.createExecutionSnapshot(
          snapshotInput(runId, env, "Run started")
        );

        // A different selection: Redis must not answer it approximately.
        const row = await decorated.findExecutionSnapshot({
          where: { id: created.id },
          select: { description: true },
        });

        expect(row).toEqual({ description: "Run started" });
        expect(reads.filter((r) => r.method === "findExecutionSnapshot")).toEqual([]);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest("serves the since window from Redis", async ({ prisma, redisOptions }) => {
    const { decorated, redis, reads } = build(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = await seedRun(decorated, env);
      const first = await decorated.createExecutionSnapshot(snapshotInput(runId, env, "First"));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await decorated.createExecutionSnapshot(snapshotInput(runId, env, "Second"));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const third = await decorated.createExecutionSnapshot(snapshotInput(runId, env, "Third"));

      const window = await decorated.findManyExecutionSnapshots({
        where: { runId, isValid: true, createdAt: { gt: first.createdAt } },
        include: { checkpoint: true },
        orderBy: { createdAt: "desc" },
        take: 50,
      });

      // Descending, exactly as the engine asked; it reverses app-side.
      expect(window.map((s) => s.id)).toEqual([third.id, second.id]);
      expect(reads).toContainEqual({ method: "findManyExecutionSnapshots", source: "redis" });
    } finally {
      await redis.quit();
    }
  });

  containerTest(
    "delegates a window query it does not recognise",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis, reads } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, env);
        await decorated.createExecutionSnapshot(snapshotInput(runId, env, "First"));

        const rows = await decorated.findManyExecutionSnapshots({
          where: { runId },
          orderBy: { createdAt: "asc" },
        });

        expect(rows.length).toBeGreaterThan(0);
        expect(reads.filter((r) => r.method === "findManyExecutionSnapshots")).toEqual([]);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "serves the waitpoint id projections from Redis",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis, reads } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, env);
        const created = await decorated.createExecutionSnapshot(
          snapshotInput(runId, env, "Run started")
        );

        const ids = await decorated.findSnapshotCompletedWaitpointIds(created.id, undefined, runId);
        const withPresence = await decorated.findSnapshotCompletedWaitpointIdsWithPresence(
          created.id,
          undefined,
          runId
        );

        expect(ids).toEqual([]);
        // present distinguishes "no waitpoints" from "this reader cannot see the snapshot", which is
        // what the engine's read-repair keys off.
        expect(withPresence).toEqual({ present: true, ids: [] });
        expect(reads).toContainEqual({
          method: "findSnapshotCompletedWaitpointIds",
          source: "redis",
        });
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "delegates a waitpoint id projection with no run id",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis, reads } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = await seedRun(decorated, env);
        const created = await decorated.createExecutionSnapshot(
          snapshotInput(runId, env, "Run started")
        );

        // Without a run id there is no keyspace to look in.
        const ids = await decorated.findSnapshotCompletedWaitpointIds(created.id);

        expect(ids).toEqual([]);
        expect(reads.filter((r) => r.method.startsWith("findSnapshot"))).toEqual([]);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest("never touches Redis for reads at mode off", async ({ prisma, redisOptions }) => {
    const { decorated, redis, reads } = build(prisma as never, redisOptions as never, {
      mode: "off",
    });
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      await decorated.createRun({
        data: buildCreateRunData(runId, env),
        snapshot: {
          id: generateInternalId(),
          engine: "V2",
          executionStatus: "RUN_CREATED",
          description: "Run was created",
          runStatus: "PENDING",
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        },
      });

      const latest = await decorated.findLatestExecutionSnapshot(runId);

      expect(latest).not.toBeNull();
      expect(await redis.getLatest(runId)).toBeNull();
      expect(reads).toEqual([]);
    } finally {
      await redis.quit();
    }
  });
});
