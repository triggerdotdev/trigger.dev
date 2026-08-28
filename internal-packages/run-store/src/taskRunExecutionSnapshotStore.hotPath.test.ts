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
