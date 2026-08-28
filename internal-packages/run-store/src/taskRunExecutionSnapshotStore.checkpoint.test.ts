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

  containerTest(
    "costs no Postgres read when the snapshot has no checkpoint",
    async ({ prisma, redisOptions }) => {
      // The other half of the split. Hydrating unconditionally would put a Postgres read back on
      // the hot path of every running run, which is what the entry's own checkpointId avoids.
      const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const plain = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      // Counted by wrapping the one method, not with a Proxy: the store holds private fields, and a
      // Proxy's receiver is not an instance of the class, so every private access throws.
      let delegateReads = 0;
      const original = plain.findExecutionSnapshot.bind(plain);
      (plain as unknown as Record<string, unknown>).findExecutionSnapshot = (
        ...args: unknown[]
      ) => {
        delegateReads += 1;
        return (original as (...a: unknown[]) => unknown)(...args);
      };
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

        delegateReads = 0;
        const read = await decorated.findLatestExecutionSnapshot(runId);

        expect(read).not.toBeNull();
        expect(read!.checkpoint).toBeNull();
        expect(delegateReads).toBe(0);
      } finally {
        await redis.quit();
      }
    }
  );
});
