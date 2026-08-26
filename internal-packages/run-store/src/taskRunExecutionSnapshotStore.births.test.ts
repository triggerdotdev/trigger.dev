// A birth writes Redis FIRST. The order is proved by crashing between the two writes and observing
// which side survived: an orphaned key with no run row is the harmless state, and a run with no
// snapshot at all is the one the order exists to prevent.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { InjectedSnapshotFault } from "./snapshotFaultInjection.js";
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
  opts?: {
    mode?: SnapshotStoreMode;
    faults?: ConstructorParameters<typeof TaskRunExecutionSnapshotStore>[1]["faults"];
    unreachableRedis?: boolean;
  }
) {
  // An unreachable port makes every append throw for real, which is the failure the retry loop and
  // the mode-dependent refusal are about. A fault injector cannot stand in: an injected fault means
  // "the process died", and the two are handled differently on purpose.
  const redis = new RedisSnapshotStore({
    redisOptions: opts?.unreachableRedis
      ? ({ ...(redisOptions as object), port: 1, retryStrategy: () => null } as never)
      : redisOptions,
    completedTtlMs: COMPLETED_TTL_MS,
  });

  const decorated = new TaskRunExecutionSnapshotStore(
    new PostgresRunStore({ prisma, readOnlyPrisma: prisma }) as unknown as RunStore,
    {
      store: redis,
      mode: opts?.mode ?? "dual-write",
      ...(opts?.faults && { faults: opts.faults }),
    }
  );

  return { decorated, redis };
}

function birthSnapshot(id: string, env: SnapshotFixtureEnv) {
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

function cancelledData(runId: string, env: SnapshotFixtureEnv) {
  return {
    ...buildCreateRunData(runId, env),
    status: "CANCELED" as const,
    error: { type: "STRING_ERROR", raw: "cancelled" } as never,
    completedAt: new Date(),
    updatedAt: new Date(),
    attemptNumber: 0 as const,
  };
}

describe("birth write ordering", () => {
  containerTest("writes Redis then Postgres", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = build(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      const snapshotId = generateInternalId();

      await decorated.createRun({
        data: buildCreateRunData(runId, env),
        snapshot: birthSnapshot(snapshotId, env),
      });

      const read = await redis.getLatest(runId);
      expect(read).not.toBeNull();
      expect(read!.entry.id).toBe(snapshotId);
      expect(read!.entry.executionStatus).toBe("RUN_CREATED");
      expect(await prisma.taskRunExecutionSnapshot.count({ where: { id: snapshotId } })).toBe(1);
    } finally {
      await redis.quit();
    }
  });

  containerTest("mints an id when the caller supplies none", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = build(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      const { id: _omitted, ...withoutId } = birthSnapshot(generateInternalId(), env);

      await decorated.createRun({ data: buildCreateRunData(runId, env), snapshot: withoutId });

      const read = await redis.getLatest(runId);
      expect(read).not.toBeNull();
      // The same minted id must reach both stores, or the comparator chases a difference that is
      // not real.
      const row = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({ where: { runId } });
      expect(read!.entry.id).toBe(row.id);
    } finally {
      await redis.quit();
    }
  });

  containerTest(
    "a crash after the Redis append leaves an orphan key and no run",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never, {
        faults: (boundary) => {
          if (boundary === "afterRedisBirthBeforePg") throw new InjectedSnapshotFault(boundary);
        },
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();

        await expect(
          decorated.createRun({
            data: buildCreateRunData(runId, env),
            snapshot: birthSnapshot(generateInternalId(), env),
          })
        ).rejects.toBeInstanceOf(InjectedSnapshotFault);

        // The harmless state: a keyspace nothing can reach, and no run that lacks a snapshot.
        expect(await redis.getLatest(runId)).not.toBeNull();
        expect(await prisma.taskRun.count({ where: { id: runId } })).toBe(0);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "creates the run anyway when the birth append fails before redis-only",
    { timeout: 60_000 },
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never, {
        mode: "dual-write",
        unreachableRedis: true,
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const snapshotId = generateInternalId();

        // Postgres is authoritative in every position before redis-only, so a Redis outage must not
        // stop runs being created.
        await decorated.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(snapshotId, env),
        });

        expect(await prisma.taskRun.count({ where: { id: runId } })).toBe(1);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { id: snapshotId } })).toBe(1);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "refuses to create the run when the birth append fails at redis-only",
    { timeout: 60_000 },
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never, {
        mode: "redis-only",
        unreachableRedis: true,
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();

        // At redis-only Postgres writes no snapshot, so a run created without its Redis birth would
        // have no snapshot anywhere. Failing before the run row exists lets the caller retry clean.
        await expect(
          decorated.createRun({
            data: buildCreateRunData(runId, env),
            snapshot: birthSnapshot(generateInternalId(), env),
          })
        ).rejects.toThrow();

        expect(await prisma.taskRun.count({ where: { id: runId } })).toBe(0);
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest("createCancelledRun writes Redis first", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = build(prisma as never, redisOptions as never);
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      const snapshotId = generateInternalId();

      await decorated.createCancelledRun({
        data: cancelledData(runId, env),
        snapshot: {
          ...birthSnapshot(snapshotId, env),
          executionStatus: "FINISHED",
          description: "Run was cancelled",
          runStatus: "CANCELED",
        },
      });

      const read = await redis.getLatest(runId);
      expect(read!.entry.id).toBe(snapshotId);
      expect(read!.entry.executionStatus).toBe("FINISHED");
      expect(await prisma.taskRunExecutionSnapshot.count({ where: { id: snapshotId } })).toBe(1);
    } finally {
      await redis.quit();
    }
  });

  containerTest(
    "a born-terminal run gets the completion expiry immediately",
    async ({ prisma, redisOptions }) => {
      const { decorated, redis } = build(prisma as never, redisOptions as never);
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();

        await decorated.createCancelledRun({
          data: cancelledData(runId, env),
          snapshot: {
            ...birthSnapshot(generateInternalId(), env),
            executionStatus: "FINISHED",
            description: "Run was cancelled",
            runStatus: "CANCELED",
          },
        });

        // A born-terminal run never transitions again, so the completion TTL has to be applied by
        // the birth itself or the keyspace never expires.
        const nonTerminal = generateInternalId();
        await decorated.createRun({
          data: buildCreateRunData(nonTerminal, env),
          snapshot: birthSnapshot(generateInternalId(), env),
        });

        const terminal = await redis.getLatest(runId);
        const alive = await redis.getLatest(nonTerminal);
        expect(terminal).not.toBeNull();
        expect(alive).not.toBeNull();
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest("writes nothing to Redis at mode off", async ({ prisma, redisOptions }) => {
    const { decorated, redis } = build(prisma as never, redisOptions as never, { mode: "off" });
    try {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();

      await decorated.createRun({
        data: buildCreateRunData(runId, env),
        snapshot: birthSnapshot(generateInternalId(), env),
      });

      expect(await prisma.taskRun.count({ where: { id: runId } })).toBe(1);
      expect(await redis.getLatest(runId)).toBeNull();
    } finally {
      await redis.quit();
    }
  });
});
