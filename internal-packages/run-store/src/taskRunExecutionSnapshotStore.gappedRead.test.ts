// P3 correction, Item 3: point reads refuse a gapped keyspace (its head disagrees with Postgres and no
// head-rebuild repair converges it). The decorator then dispatches per residency: a MIRRORED run reads
// its complete Postgres copy; a REDIS-PRIMARY run fails closed. Real Postgres + Redis.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  SnapshotReadUnavailableError,
  TaskRunExecutionSnapshotStore,
} from "./taskRunExecutionSnapshotStore.js";
import { SnapshotResidencyResolver } from "./snapshotResidencyResolver.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";

function birthSnapshot(env: Awaited<ReturnType<typeof seedSnapshotEnvironment>>, id: string) {
  return {
    id,
    createdAt: new Date(),
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

describe("decorator reads over a gapped keyspace (P3 correction, Item 3)", () => {
  containerTest(
    "mirrored falls back to the complete Postgres copy; redis-primary fails closed",
    async ({ prisma, redisOptions }) => {
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const mk = (dial: "redis-read" | "redis-only") =>
        new TaskRunExecutionSnapshotStore(delegate, {
          store: snapshotStore,
          mode: "redis-only",
          resolveDial: () => dial,
          residencyResolver: new SnapshotResidencyResolver({
            store: snapshotStore,
            taskRunExists: async (id: string) =>
              (await prisma.taskRun.count({ where: { id } })) > 0,
          }),
          logicalRunStoreRoute: ROUTE,
        });
      try {
        const env = await seedSnapshotEnvironment(prisma);

        // Mirrored: birth writes BOTH the MemoryDB head and the complete Postgres copy. Gap the keyspace
        // and the point read refuses the MemoryDB head, so the decorator serves the Postgres row.
        const mirrored = mk("redis-read");
        const mrId = generateInternalId();
        const mrBirth = generateInternalId();
        await mirrored.createRun({
          data: buildCreateRunData(mrId, env),
          snapshot: birthSnapshot(env, mrBirth),
        });
        await snapshotStore.markGaps(mrId);
        const mrHead = await mirrored.findLatestExecutionSnapshot(mrId);
        expect(mrHead?.id).toBe(mrBirth);

        // Redis-primary: birth writes only MemoryDB. Gap the keyspace and the point read refuses it;
        // with no Postgres copy the decorator must fail closed rather than answer empty.
        const redisPrimary = mk("redis-only");
        const rpId = generateInternalId();
        await redisPrimary.createRun({
          data: buildCreateRunData(rpId, env),
          snapshot: birthSnapshot(env, generateInternalId()),
        });
        await snapshotStore.markGaps(rpId);
        await expect(redisPrimary.findLatestExecutionSnapshot(rpId)).rejects.toThrow(
          SnapshotReadUnavailableError
        );
      } finally {
        await snapshotStore.quit();
      }
    }
  );
});
