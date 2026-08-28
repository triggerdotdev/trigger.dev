// Problem: at `off` the store still put Redis on the run path for EVERY run. Births were dial-gated,
// but transitions were not, and the residency test lives inside the Lua script, so the store had to
// complete a round trip just to learn a run was not its own. Measured live: 2 percent with a healthy
// Redis, 4x (34187ms against 8258ms) under a brownout, for every run, with no decay as resident runs
// drained.
//
// These tests count actual Redis commands, because that is the claim. A latency assertion would pass
// on a fast local Redis while the round trip was still there.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Script calls the server has served. Counts EVAL as well as EVALSHA: ioredis sends EVALSHA and
 * falls back to EVAL when the server has not cached the script yet, so counting one of them alone
 * reads as zero on a cold server and the assertion passes for the wrong reason.
 */
async function scriptCalls(probe: { info: (section: string) => Promise<string> }): Promise<number> {
  const stats = await probe.info("commandstats");
  const of = (cmd: string) =>
    Number(new RegExp(`cmdstat_${cmd}:calls=(\\d+)`).exec(stats)?.[1] ?? 0);
  return of("eval") + of("evalsha");
}

function birthSnapshot(env: SnapshotFixtureEnv) {
  return {
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

/**
 * A real store whose waitpoint-id lookup fails. Used to make the SECOND Redis call of a read fail
 * after the first has succeeded, which is the only way to reach the hydration fallback.
 */
class HydrationFailingStore extends RedisSnapshotStore {
  hydrationCalls = 0;

  override async getSnapshotWaitpointIds(
    ...args: Parameters<RedisSnapshotStore["getSnapshotWaitpointIds"]>
  ): ReturnType<RedisSnapshotStore["getSnapshotWaitpointIds"]> {
    this.hydrationCalls += 1;
    void args;
    throw new Error("Command timed out");
  }
}

describe("Redis stays off the hot path for a non-resident run", () => {
  containerTest(
    "a run born at off probes once, then never again",
    async ({ prisma, redisOptions }) => {
      const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const decorated = new TaskRunExecutionSnapshotStore(
        new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) as unknown as RunStore,
        { store: redis, mode: "off" }
      );
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();

        await decorated.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env),
        });

        // Nothing is assumed from the birth decision. A birth path can be re-entered, so a local
        // "did not mirror" is not proof of anything; only the script's reply is.
        expect(redis.residencyFor(runId)).toBeUndefined();

        const before = await scriptCalls(probe);
        await decorated.completeAttemptSuccess(runId, completionInput(env), {
          select: { id: true },
        });
        const mid = await scriptCalls(probe);

        // One probe, which is what makes the answer authoritative.
        expect(mid - before).toBe(1);
        expect(redis.residencyFor(runId)).toBe("non-resident");

        // The assertion that matters. Before the cache this was one script call per transition, for
        // the life of every run, and under a brownout each one cost the full retry budget.
        await decorated.completeAttemptSuccess(runId, completionInput(env), {
          select: { id: true },
        });
        await decorated.completeAttemptSuccess(runId, completionInput(env), {
          select: { id: true },
        });
        expect((await scriptCalls(probe)) - mid).toBe(0);
      } finally {
        await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "a resident run still mirrors, so the cache cannot be a blanket off switch",
    async ({ prisma, redisOptions }) => {
      const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const decorated = new TaskRunExecutionSnapshotStore(
        new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) as unknown as RunStore,
        { store: redis, mode: "dual-write" }
      );
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();

        await decorated.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env),
        });

        expect(redis.residencyFor(runId)).toBe("resident");

        await decorated.completeAttemptSuccess(runId, completionInput(env), {
          select: { id: true },
        });

        const head = await redis.getLatest(runId);
        expect(head?.entry.executionStatus).toBe("FINISHED");
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "a probe that finds no keyspace is remembered, so it happens once and not once per transition",
    async ({ prisma, redisOptions }) => {
      // The cold-cache case: a process that did not see the birth. It probes once, learns, and stops.
      const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const decorated = new TaskRunExecutionSnapshotStore(
        new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) as unknown as RunStore,
        { store: redis, mode: "dual-write" }
      );
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        // A run row with no keyspace, exactly as a run born elsewhere at off would look.
        await prisma.taskRun.create({ data: buildCreateRunData(runId, env) });
        expect(redis.residencyFor(runId)).toBeUndefined();

        const first = await scriptCalls(probe);
        await decorated.completeAttemptSuccess(runId, completionInput(env), {
          select: { id: true },
        });
        const second = await scriptCalls(probe);

        // One probe, and it taught the cache.
        expect(second - first).toBe(1);
        expect(redis.residencyFor(runId)).toBe("non-resident");

        await decorated.completeAttemptSuccess(runId, completionInput(env), {
          select: { id: true },
        });
        const third = await scriptCalls(probe);
        expect(third - second).toBe(0);
      } finally {
        await Promise.all([redis.quit(), probe.quit().catch(() => {})]);
      }
    }
  );
});

describe("a Redis that stops answering", () => {
  containerTest(
    "serves reads from Postgres instead of throwing into the engine",
    async ({ prisma, redisOptions }) => {
      // The read paths fell back on a miss and on a dangling cycle, but not on an ERROR, so a
      // brownout at redis-read turned an engine read into a throw once the command timed out.
      const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const decorated = new TaskRunExecutionSnapshotStore(
        new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) as unknown as RunStore,
        { store: redis, mode: "redis-read", readPercent: 100 }
      );
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await decorated.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env),
        });

        // Reads work while Redis answers.
        expect(await decorated.findLatestExecutionSnapshot(runId)).not.toBeNull();

        // Now take Redis away underneath it, the way a brownout does.
        await redis.quit();

        const served = await decorated.findLatestExecutionSnapshot(runId);
        expect(served).not.toBeNull();
        expect(served!.runId).toBe(runId);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest("stops calling out once the circuit opens", async ({ prisma, redisOptions }) => {
    const redis = new RedisSnapshotStore({
      redisOptions,
      completedTtlMs: COMPLETED_TTL_MS,
      breaker: { failureThreshold: 2, openDurationMs: 60_000 },
    });
    const decorated = new TaskRunExecutionSnapshotStore(
      new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) as unknown as RunStore,
      { store: redis, mode: "redis-read", readPercent: 100 }
    );
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      await decorated.createRun({
        data: buildCreateRunData(runId, env),
        snapshot: birthSnapshot(env),
      });

      await redis.quit();
      expect(redis.breakerState).toBe("closed");

      for (let i = 0; i < 4; i++) {
        expect(await decorated.findLatestExecutionSnapshot(runId)).not.toBeNull();
      }

      // Open, so every later call is refused locally rather than waiting out another timeout. This
      // is what bounds the cold-cache probe under a brownout.
      expect(redis.breakerState).toBe("open");
    } finally {
      await redis.quit();
    }
  });
  containerTest(
    "falls back even when the SECOND Redis call is the one that fails",
    async ({ prisma, redisOptions }) => {
      // The first fix caught the read itself but stopped before hydration. A snapshot with a wait
      // cycle whose ids were not carried by the read makes a follow-up Redis call inside #hydrate,
      // and a failure there threw straight into the engine at redis-read, which is the case the
      // fallback exists for.
      //
      // A subclass rather than a replaced property: this is a real store on a real connection, so
      // every other command still goes through the production path and the real cluster. Only the
      // one command under test is specialised, because the scenario needs a SECOND Redis call to
      // fail after a first has already succeeded, and no seam exposes that. The write-path fault
      // injector models process crashes, not command failures, so it is the wrong tool here.
      const redis = new HydrationFailingStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const plain = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const decorated = new TaskRunExecutionSnapshotStore(plain as unknown as RunStore, {
        store: redis,
        mode: "redis-read",
        readPercent: 100,
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await decorated.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env),
        });

        // A transition carrying a wait cycle, so the head has waitpoints and hydration has a reason
        // to ask Redis for them.
        const waitpoint = await prisma.waitpoint.create({
          data: {
            friendlyId: `waitpoint_${generateInternalId()}`,
            type: "MANUAL",
            status: "COMPLETED",
            completedAt: new Date(),
            idempotencyKey: generateInternalId(),
            userProvidedIdempotencyKey: false,
            environmentId: env.id,
            projectId: env.projectId,
          },
        });
        await decorated.createExecutionSnapshot({
          run: { id: runId, status: "EXECUTING" },
          snapshot: { executionStatus: "EXECUTING", description: "Resumed" },
          completedWaitpoints: [{ id: waitpoint.id, index: 0 }],
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        } as never);

        // One more transition, so the waitpoint-bearing entry is no longer the head. Only the HEAD
        // row of a window is decoded with its waitpoint ids; every other row has to ask, and that
        // ask is the second Redis call this test is about.
        await decorated.createExecutionSnapshot({
          run: { id: runId, status: "EXECUTING" },
          snapshot: { executionStatus: "EXECUTING", description: "Still executing" },
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        } as never);

        // The WINDOW read, not the head read. The head read carries the waitpoint ids already, so
        // its hydration never asks Redis; the window entries do not, which is where the second call
        // lives and where the gap was.
        const served = await decorated.findManyExecutionSnapshots({
          where: { runId, isValid: true, createdAt: { gt: new Date(Date.now() - 3_600_000) } },
          include: { checkpoint: true },
          orderBy: { createdAt: "desc" },
          take: 10,
        } as never);

        expect(Array.isArray(served)).toBe(true);
        expect(served.length).toBeGreaterThan(0);

        // Asserted, not hoped for: without this the test passes on a run whose hydration never
        // reaches Redis, and proves nothing at all.
        expect(redis.hydrationCalls).toBeGreaterThanOrEqual(1);
      } finally {
        await redis.quit();
      }
    }
  );
  containerTest(
    "records the read source ONCE, not once per attempt",
    async ({ prisma, redisOptions }) => {
      // Adding the hydration fallback after the recordRead call meant one logical read incremented
      // BOTH series: `redis` on the way in, then `postgres` when hydration fell back. Any dashboard
      // built on read_source then over-counts, and the redis/postgres split stops summing to the
      // number of reads.
      const redis = new HydrationFailingStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const plain = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const reads: { method: string; servedBy: string }[] = [];
      const decorated = new TaskRunExecutionSnapshotStore(plain as unknown as RunStore, {
        store: redis,
        mode: "redis-read",
        readPercent: 100,
        metrics: {
          recordWrite: () => {},
          recordAppendFailed: () => {},
          recordRead: (method, servedBy) => reads.push({ method, servedBy }),
        },
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await decorated.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env),
        });

        const waitpoint = await prisma.waitpoint.create({
          data: {
            friendlyId: `waitpoint_${generateInternalId()}`,
            type: "MANUAL",
            status: "COMPLETED",
            completedAt: new Date(),
            idempotencyKey: generateInternalId(),
            userProvidedIdempotencyKey: false,
            environmentId: env.id,
            projectId: env.projectId,
          },
        });
        await decorated.createExecutionSnapshot({
          run: { id: runId, status: "EXECUTING" },
          snapshot: { executionStatus: "EXECUTING", description: "Resumed" },
          completedWaitpoints: [{ id: waitpoint.id, index: 0 }],
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        } as never);
        await decorated.createExecutionSnapshot({
          run: { id: runId, status: "EXECUTING" },
          snapshot: { executionStatus: "EXECUTING", description: "Still executing" },
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        } as never);

        reads.length = 0;
        const served = await decorated.findManyExecutionSnapshots({
          where: { runId, isValid: true, createdAt: { gt: new Date(Date.now() - 3_600_000) } },
          include: { checkpoint: true },
          orderBy: { createdAt: "desc" },
          take: 10,
        } as never);

        expect(served.length).toBeGreaterThan(0);
        // Hydration failed, so Postgres served it, and that is the ONLY thing recorded.
        expect(reads).toEqual([{ method: "findManyExecutionSnapshots", servedBy: "postgres" }]);
      } finally {
        await redis.quit();
      }
    }
  );
});
