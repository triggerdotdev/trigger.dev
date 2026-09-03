// Gate 14. A suspended run's snapshot points at a checkpoint, and that is how the run is resumed.
// The entry in Redis carries only `checkpointId`: the checkpoint ROW stays in Postgres and is read
// back through the delegate, and only when the entry says one exists, so the common read of a
// running run with no checkpoint costs no Postgres call at all.
//
// That split is the thing worth testing. A Redis-served snapshot that dropped its checkpoint, or
// returned it in a different shape than the Postgres read, would resume a run with nowhere to
// restore from, and the mirror would look healthy while doing it.
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
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

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

describe("a checkpoint on a snapshot served from Redis", () => {
  containerTest(
    "comes back, and matches what Postgres would have returned",
    async ({ prisma, redisOptions }) => {
      const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
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

        const checkpoint = await prisma.taskRunCheckpoint.create({
          data: {
            friendlyId: `checkpoint_${generateInternalId()}`,
            type: "DOCKER",
            location: "s3://bucket/checkpoint.tar",
            imageRef: "registry/image@sha256:abc",
            reason: "wait for duration",
            projectId: env.projectId,
            runtimeEnvironmentId: env.id,
          },
        });

        // A suspend transition: the snapshot names the checkpoint the run must restore from.
        await decorated.createExecutionSnapshot({
          run: { id: runId, status: "WAITING_TO_RESUME" },
          snapshot: {
            executionStatus: "SUSPENDED",
            description: "Run was suspended",
          },
          // Top level, not inside `snapshot`.
          checkpointId: checkpoint.id,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        } as never);

        // Served from Redis, because the dial is at redis-read and the run is resident.
        const fromRedis = await decorated.findLatestExecutionSnapshot(runId);
        // The same question asked of Postgres alone, as the oracle.
        const fromPostgres = await plain.findLatestExecutionSnapshot(runId);

        expect(fromRedis).not.toBeNull();
        expect(fromRedis!.executionStatus).toBe("SUSPENDED");

        // The identifier survived the trip through Redis.
        expect(fromRedis!.checkpointId).toBe(checkpoint.id);

        // And the ROW was re-attached, not just the id. A resume needs the location and the image.
        expect(fromRedis!.checkpoint).not.toBeNull();
        expect(fromRedis!.checkpoint!.id).toBe(checkpoint.id);
        expect(fromRedis!.checkpoint!.location).toBe("s3://bucket/checkpoint.tar");
        expect(fromRedis!.checkpoint!.imageRef).toBe("registry/image@sha256:abc");

        // The claim that matters: the two stores answer identically.
        expect(fromRedis!.checkpoint).toEqual(fromPostgres!.checkpoint);
      } finally {
        await redis.quit();
      }
    }
  );

  // The shipping redis-only PAIR: decorator at redis-only OVER a store with snapshotWrites:false, so
  // the TaskRunExecutionSnapshot row is NOT written to Postgres. The checkpoint ROW still lives in
  // Postgres (only snapshot rows are suppressed), and the Redis entry carries checkpointId. A resume
  // MUST still re-attach the checkpoint row. If hydration reads it through the (suppressed) snapshot
  // row, the resumed run gets a null checkpoint and restarts with no state to restore from.
  containerTest(
    "at redis-only, a suspended run's checkpoint still hydrates (snapshot row suppressed)",
    async ({ prisma, redisOptions }) => {
      const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      // snapshotWrites:false is redis-only: run mutations land, snapshot rows do not.
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma, snapshotWrites: false });
      const decorated = new TaskRunExecutionSnapshotStore(store as unknown as RunStore, {
        store: redis,
        mode: "redis-only",
        readPercent: 100,
      });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();

        await decorated.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env),
        });

        const checkpoint = await prisma.taskRunCheckpoint.create({
          data: {
            friendlyId: `checkpoint_${generateInternalId()}`,
            type: "DOCKER",
            location: "s3://bucket/redis-only-checkpoint.tar",
            imageRef: "registry/image@sha256:def",
            reason: "suspend at redis-only",
            projectId: env.projectId,
            runtimeEnvironmentId: env.id,
          },
        });

        // Suspend transition naming the checkpoint. At redis-only the snapshot row is suppressed in PG.
        await decorated.createExecutionSnapshot({
          run: { id: runId, status: "WAITING_TO_RESUME" },
          snapshot: { executionStatus: "SUSPENDED", description: "Run was suspended" },
          checkpointId: checkpoint.id,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        } as never);

        // Confirm the redis-only premise: NO snapshot row for this run exists in Postgres.
        const pgSnapshotCount = await prisma.taskRunExecutionSnapshot.count({ where: { runId } });
        expect(pgSnapshotCount).toBe(0);

        // The resume read is served from Redis. It MUST still carry the checkpoint id AND the row.
        const fromRedis = await decorated.findLatestExecutionSnapshot(runId);
        expect(fromRedis).not.toBeNull();
        expect(fromRedis!.executionStatus).toBe("SUSPENDED");
        expect(fromRedis!.checkpointId).toBe(checkpoint.id);

        // The load-bearing assertion: the checkpoint ROW is re-attached, hydrated directly from the
        // TaskRunCheckpoint table (not via the suppressed snapshot row), so the run can restore.
        expect(fromRedis!.checkpoint).not.toBeNull();
        expect(fromRedis!.checkpoint!.id).toBe(checkpoint.id);
        expect(fromRedis!.checkpoint!.location).toBe("s3://bucket/redis-only-checkpoint.tar");
        expect(fromRedis!.checkpoint!.imageRef).toBe("registry/image@sha256:def");
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "costs no Postgres read when the snapshot has no checkpoint",
    async ({ prisma, redisOptions }) => {
      // The other half of the split. Hydrating unconditionally would put a Postgres read back on
      // the hot path of every running run, which is what the entry's own checkpointId avoids.
      const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const plain = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      // Observed through the store's own metrics seam rather than by replacing a method on the
      // production store. `recordRead` reports which store served each read, which is exactly the
      // question, and it is an injection point the class already offers.
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

        reads.length = 0;
        const read = await decorated.findLatestExecutionSnapshot(runId);

        expect(read).not.toBeNull();
        expect(read!.checkpoint).toBeNull();
        // Served entirely by Redis. Hydrating unconditionally would put a Postgres read back on the
        // hot path of every running run, which is the cost the entry's own checkpointId avoids.
        expect(reads).toEqual([{ method: "findLatestExecutionSnapshot", servedBy: "redis" }]);
      } finally {
        await redis.quit();
      }
    }
  );
});
