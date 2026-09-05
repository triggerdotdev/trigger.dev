// `redis-only` is the terminal cutover, and it is the only dial position where Postgres stops being
// authoritative: it cannot be rolled back by turning the dial down, because the snapshots written
// while it was on exist nowhere else. Suppression is now a per-run decision the decorator makes: a
// run BORN while the decorator resolves `redis-only` has its Postgres snapshot rows suppressed for
// life (the decorator threads `writeSnapshotRow: false` onto every write), so the store underneath
// needs no separate `snapshotWrites` setting — the decorator alone drives the pair.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  seedSnapshotWaitpoints,
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

/** The shipping pair: decorator at `redis-only` over a store that writes no snapshot rows. */
function build(prisma: never, redisOptions: never) {
  const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
  const reads: { method: string; source: string }[] = [];

  const decorated = new TaskRunExecutionSnapshotStore(
    new PostgresRunStore({
      prisma,
      readOnlyPrisma: prisma,
    }) as unknown as RunStore,
    {
      store: redis,
      mode: "redis-only",
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

function transition(runId: string, env: SnapshotFixtureEnv, description: string) {
  return {
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING" as const, description },
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

describe("redis-only: Postgres stops holding snapshots", () => {
  containerTest("the run row lands but no snapshot row does", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = build(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const { runId, snapshotId } = await seedRun(decorated, env);

      // The run itself is still Postgres-authoritative at this position. Only its snapshots move.
      expect(await prisma.taskRun.count({ where: { id: runId } })).toBe(1);
      expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

      // And the snapshot is genuinely in Redis under the id the caller minted.
      const head = await redis.getLatest(runId);
      expect(head?.id).toBe(snapshotId);
    } finally {
      await redis.quit();
    }
  });

  containerTest("transitions write no snapshot row either", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = build(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const { runId } = await seedRun(decorated, env);

      await decorated.createExecutionSnapshot(transition(runId, env, "Run started"));
      await decorated.createExecutionSnapshot(transition(runId, env, "Run continued"));

      expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
      const since = await redis.getSinceCreatedAt(runId, new Date(Date.now() - 60_000), {
        limit: 50,
      });
      expect(since.kind).toBe("hit");
      expect(since.kind === "hit" ? since.entries.length : 0).toBeGreaterThanOrEqual(2);
    } finally {
      await redis.quit();
    }
  });

  containerTest(
    "a completion still updates the run row while writing no snapshot",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const { runId } = await seedRun(decorated, env);

        await decorated.completeAttemptSuccess(
          runId,
          {
            completedAt: new Date(),
            outputType: "application/json",
            usageDurationMs: 1,
            costInCents: 0,
            snapshot: {
              id: generateInternalId(),
              executionStatus: "FINISHED",
              description: "Run completed",
              runStatus: "COMPLETED_SUCCESSFULLY",
              attemptNumber: 1,
              environmentId: env.id,
              environmentType: env.type,
              projectId: env.projectId,
              organizationId: env.organizationId,
            },
          },
          { select: { id: true } }
        );

        // The mutation half of a nested write must still land, or the run never finishes.
        const run = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
        expect(run.status).toBe("COMPLETED_SUCCESSFULLY");
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "no completed-waitpoint join rows are written for a snapshot Postgres does not have",
    async ({ prisma, redisOptions }) => {
      // The join rows point at a snapshot row. With snapshot writes off there is no such row, so
      // inserting them would leave links dangling at a snapshot only Redis holds.
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const { runId } = await seedRun(decorated, env);
        const [wpA, wpB] = await seedSnapshotWaitpoints(prisma, env, 2);

        await decorated.createExecutionSnapshot({
          ...transition(runId, env, "Run resumed"),
          completedWaitpoints: [
            { id: wpA, index: 0 },
            { id: wpB, index: 1 },
          ],
        });

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
        const joins = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "_completedWaitpoints" WHERE "B" = ANY($1::text[])`,
          [wpA, wpB]
        );
        expect(Number(joins[0]!.n)).toBe(0);
      } finally {
        await redis.quit();
      }
    }
  );
});

describe("redis-only: every read is served from Redis", () => {
  containerTest(
    "the hot read, the since window and the waitpoint lookups all come from Redis",
    async ({ prisma, redisOptions }) => {
      // At every earlier position a Redis miss falls back to Postgres and the caller never notices.
      // Here Postgres holds nothing, so a read that fell back would answer empty rather than wrong,
      // and a run would silently lose its state. Each read is asserted to be Redis-sourced.
      const { decorated, redis, reads } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const { runId } = await seedRun(decorated, env);
        const [wpA] = await seedSnapshotWaitpoints(prisma, env, 1);
        const created = await decorated.createExecutionSnapshot({
          ...transition(runId, env, "Run resumed"),
          completedWaitpoints: [{ id: wpA, index: 0 }],
        });

        const latest = await decorated.findLatestExecutionSnapshot(runId);
        expect(latest!.id).toBe(created.id);
        expect(latest!.completedWaitpointOrder).toEqual([wpA]);

        const window = await decorated.findManyExecutionSnapshots({
          where: { runId, isValid: true, createdAt: { gt: new Date(Date.now() - 60_000) } },
          include: { checkpoint: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
        expect(window.length).toBeGreaterThan(0);

        const withPresence = await decorated.findSnapshotCompletedWaitpointIdsWithPresence(
          created.id,
          undefined,
          runId
        );
        expect(withPresence.ids).toEqual([wpA]);

        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((r) => r.source === "redis")).toBe(true);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "an unrecognised read shape falls through to a Postgres that holds nothing",
    async ({ prisma, redisOptions }) => {
      // CHARACTERISATION, NOT AN ENDORSEMENT. `findManyExecutionSnapshots` serves from Redis only
      // for the since-window shape `matchSinceWindow` recognises; anything else delegates. At every
      // dial position before this one that is harmless, because Postgres holds the same rows. Here
      // it holds none, so the caller gets an EMPTY result rather than an error, and empty is a
      // valid answer to this query. The same is true of the `miss` and `danglingCycle` fallbacks in
      // that method: all three are safe everywhere except the one position that cannot fall back.
      //
      // Only the engine's own call shapes reach this method today, and it issues the since-window
      // one, so nothing is broken. It is pinned here so the terminal-cutover ticket decides
      // deliberately whether a fall-through at `redis-only` should throw instead of answering
      // empty, rather than discovering this shape in production.
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const { runId } = await seedRun(decorated, env);
        await decorated.createExecutionSnapshot(transition(runId, env, "Run started"));

        // No `createdAt` cursor, so the shape does not match and the read is delegated.
        const unmatched = await decorated.findManyExecutionSnapshots({
          where: { runId, isValid: true },
          include: { checkpoint: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        });

        expect(unmatched).toEqual([]);

        // The same run, asked the shape the engine actually issues, answers in full from Redis.
        const matched = await decorated.findManyExecutionSnapshots({
          where: { runId, isValid: true, createdAt: { gt: new Date(Date.now() - 60_000) } },
          include: { checkpoint: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
        expect(matched.length).toBeGreaterThan(0);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest("a redis-only run always reads from Redis", async ({ prisma, redisOptions }) => {
    // At `redis-only` a run routed to Postgres would read a database that holds no snapshots at
    // all, so every run reads from Redis here.
    const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
    const reads: string[] = [];
    const decorated = new TaskRunExecutionSnapshotStore(
      new PostgresRunStore({
        prisma: prisma as never,
        readOnlyPrisma: prisma as never,
      }) as unknown as RunStore,
      {
        store: redis,
        mode: "redis-only",
        metrics: {
          recordWrite: () => {},
          recordAppendFailed: () => {},
          recordRead: (_m, source) => reads.push(source),
        },
      }
    );

    try {
      const env = await seedSnapshotEnvironment(prisma);
      const { runId, snapshotId } = await seedRun(decorated, env);

      const latest = await decorated.findLatestExecutionSnapshot(runId);

      expect(latest!.id).toBe(snapshotId);
      expect(reads).not.toContain("postgres");
    } finally {
      await redis.quit();
    }
  });
});
