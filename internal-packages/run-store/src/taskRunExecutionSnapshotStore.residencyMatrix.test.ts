// The residency transition matrix: a run's store is fixed at BIRTH and never re-derived from the live
// org dial. Each case drives a real Postgres and a real Redis through the decorator and asserts WHERE
// the write lands and WHERE the read is served, so no run is stranded or lost as the dial drifts,
// halts, or is turned down. These are the RED->GREEN cases the per-run residency model exists for.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreMode,
  type SnapshotStoreModeResolver,
} from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

// A mutable dial the test drives directly: `global` is the deployment-wide position, `orgMode` an
// optional per-org override, and the census/halt flags feed the decorator's read and hard-stop gates.
type Dial = {
  global: SnapshotStoreMode;
  orgMode?: SnapshotStoreMode;
  anyRedisOnly: boolean;
  anyReadEnabled: boolean;
  halted: boolean;
};

function build(prisma: never, redisOptions: never, dial: Dial) {
  const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
  const reads: { method: string; source: string }[] = [];

  const modeResolver: SnapshotStoreModeResolver = {
    resolve: (organizationId?: string) =>
      organizationId !== undefined && dial.orgMode !== undefined ? dial.orgMode : dial.global,
    anyOrgRedisOnly: () => dial.anyRedisOnly,
    anyOrgReadEnabled: () => dial.anyReadEnabled,
  };

  const decorated = new TaskRunExecutionSnapshotStore(
    new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) as unknown as RunStore,
    {
      store: redis,
      modeResolver,
      halted: () => dial.halted,
      metrics: {
        recordWrite: () => {},
        recordAppendFailed: () => {},
        recordRead: (method, source) => reads.push({ method, source }),
      },
    }
  );

  return { decorated, redis, reads };
}

function birth(env: SnapshotFixtureEnv, id: string) {
  return {
    id,
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

async function seedRun(decorated: TaskRunExecutionSnapshotStore, env: SnapshotFixtureEnv) {
  const runId = generateInternalId();
  const snapshotId = generateInternalId();
  await decorated.createRun({
    data: buildCreateRunData(runId, env),
    snapshot: birth(env, snapshotId),
  });
  return { runId, snapshotId };
}

function completion(runId: string, env: SnapshotFixtureEnv) {
  return [
    runId,
    {
      completedAt: new Date(),
      outputType: "application/json",
      usageDurationMs: 1,
      costInCents: 0,
      snapshot: {
        id: generateInternalId(),
        executionStatus: "FINISHED" as const,
        description: "Run completed",
        runStatus: "COMPLETED_SUCCESSFULLY" as const,
        attemptNumber: 1,
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      },
    },
    { select: { id: true } },
  ] as const;
}

describe("residency transition matrix", () => {
  containerTest(
    "1. a born-off run keeps writing to Postgres after the org moves to redis-only",
    async ({ prisma, redisOptions }) => {
      // Born while off => Postgres-backed for life. When the org later moves to redis-only, its
      // transitions must STILL land in Postgres (the run has no Redis keyspace), and its reads must
      // still be served from Postgres. On today's code the transition would try to mirror, the append
      // would be judged unrecoverable at redis-only, and the run would strand.
      const dial: Dial = {
        global: "off",
        anyRedisOnly: false,
        anyReadEnabled: false,
        halted: false,
      };
      const { decorated, redis } = build(prisma as never, redisOptions as never, dial);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const { runId } = await seedRun(decorated, env);

        // Born off: Postgres holds the birth snapshot, Redis holds nothing.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(1);
        expect(await redis.getLatest(runId)).toBeNull();

        // The whole deployment (and this org) advances to redis-only AFTER the birth.
        dial.global = "redis-only";
        dial.orgMode = "redis-only";
        dial.anyRedisOnly = true;
        dial.anyReadEnabled = true;

        // A transition still lands in Postgres, and does not throw.
        await (decorated.completeAttemptSuccess as (...a: never[]) => Promise<unknown>)(
          ...(completion(runId, env) as never[])
        );

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(2);
        const run = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
        expect(run.status).toBe("COMPLETED_SUCCESSFULLY");

        // And the read is served from Postgres, never an empty Redis.
        const latest = await decorated.findLatestExecutionSnapshot(runId);
        expect(latest?.runId).toBe(runId);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "2. a birth while the org dial is not redis-only is born Postgres-backed, even under a global redis-only",
    async ({ prisma, redisOptions }) => {
      // Poll-lag / resident-org window: the global dial reads redis-only, but this org's own dial is
      // still dual-write, so the run must be born Postgres-backed and lose nothing.
      const dial: Dial = {
        global: "redis-only",
        orgMode: "dual-write",
        anyRedisOnly: true,
        anyReadEnabled: true,
        halted: false,
      };
      const { decorated, redis } = build(prisma as never, redisOptions as never, dial);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const { runId, snapshotId } = await seedRun(decorated, env);

        // Postgres holds the birth snapshot (the org was dual-write at birth), so nothing is lost.
        expect(
          await prisma.taskRunExecutionSnapshot.count({ where: { runId, id: snapshotId } })
        ).toBe(1);
        // It also mirrors to Redis (dual-write), but Postgres is authoritative and complete.
        const latest = await decorated.findLatestExecutionSnapshot(runId);
        expect(latest?.id).toBe(snapshotId);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "3. downgrade redis-only -> dual-write: the old run still reads Redis, a new run reads Postgres",
    async ({ prisma, redisOptions }) => {
      const dial: Dial = {
        global: "redis-only",
        anyRedisOnly: true,
        anyReadEnabled: true,
        halted: false,
      };
      const { decorated, redis, reads } = build(prisma as never, redisOptions as never, dial);
      try {
        const env = await seedSnapshotEnvironment(prisma);

        // A run born redis-only: no Postgres snapshot row, Redis holds it.
        const old = await seedRun(decorated, env);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: old.runId } })).toBe(
          0
        );

        // The whole deployment is turned back down to dual-write.
        dial.global = "dual-write";
        dial.anyRedisOnly = false;
        dial.anyReadEnabled = false;

        // The existing redis-only-born run STILL reads from Redis (Postgres holds nothing for it).
        reads.length = 0;
        const oldLatest = await decorated.findLatestExecutionSnapshot(old.runId);
        expect(oldLatest?.id).toBe(old.snapshotId);
        expect(reads.some((r) => r.source === "redis")).toBe(true);
        expect(reads.some((r) => r.source === "postgres")).toBe(false);

        // A NEW run born at dual-write is Postgres-backed: its snapshot lands in Postgres.
        const fresh = await seedRun(decorated, env);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: fresh.runId } })).toBe(
          1
        );
        const freshLatest = await decorated.findLatestExecutionSnapshot(fresh.runId);
        expect(freshLatest?.id).toBe(fresh.snapshotId);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "4. a redis-only-born run refuses a Postgres fallback on a Redis miss (retryable throw)",
    async ({ prisma, redisOptions }) => {
      const dial: Dial = {
        global: "redis-only",
        anyRedisOnly: true,
        anyReadEnabled: true,
        halted: false,
      };
      const { decorated, redis } = build(prisma as never, redisOptions as never, dial);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const { runId } = await seedRun(decorated, env);

        // Drop the keyspace to force a miss with no Postgres to serve the run.
        await redis.dropRun(runId);

        // The read must THROW (retryable), never serve an empty Postgres as though it were the truth.
        await expect(decorated.findLatestExecutionSnapshot(runId)).rejects.toThrow();
        // And Postgres genuinely holds nothing for it, so a fallback WOULD have stranded the run.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "5. a halt while the org is redis-only writes the snapshot row to Postgres",
    async ({ prisma, redisOptions }) => {
      const dial: Dial = {
        global: "redis-only",
        anyRedisOnly: true,
        anyReadEnabled: true,
        halted: false,
      };
      const { decorated, redis } = build(prisma as never, redisOptions as never, dial);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const { runId } = await seedRun(decorated, env);

        // Born redis-only: no Postgres snapshot yet.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        // The hard stop is thrown. A halt forces Postgres writes back on so the run advances
        // SOMEWHERE, rather than the redis-only run writing its transition nowhere at all.
        dial.halted = true;

        await (decorated.completeAttemptSuccess as (...a: never[]) => Promise<unknown>)(
          ...(completion(runId, env) as never[])
        );

        // The completion snapshot IS written to Postgres during the halt.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(1);
        const run = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
        expect(run.status).toBe("COMPLETED_SUCCESSFULLY");
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "6. a Postgres-backed run reads from Postgres while another org is redis-only, no throw, no probe",
    async ({ prisma, redisOptions }) => {
      // A run born dual-write is Postgres-backed. That SOME other org is at redis-only must not make
      // its reads refuse a Postgres they can be served from — the dequeue deadlock the old per-read
      // authoritative DB read produced.
      const dial: Dial = {
        global: "dual-write",
        orgMode: "dual-write",
        anyRedisOnly: true,
        anyReadEnabled: true,
        halted: false,
      };
      const { decorated, redis } = build(prisma as never, redisOptions as never, dial);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const { runId, snapshotId } = await seedRun(decorated, env);

        // Postgres holds its whole log.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(1);

        // The read succeeds from Postgres (its regime is known Postgres-backed from the birth), no
        // throw, and no residency round-trip is needed.
        const latest = await decorated.findLatestExecutionSnapshot(runId);
        expect(latest?.id).toBe(snapshotId);
      } finally {
        await redis.quit();
      }
    }
  );
});
