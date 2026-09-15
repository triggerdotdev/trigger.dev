// P3 correction: readSnapshotRoute({ forceDurable: true }) is the scheduled/background transition
// path. It must fail CLOSED on a poll-lagging pod — an unresolvable durable residency throws rather
// than returning undefined (which would activate the never-enrolled Postgres shortcut and strand an
// enrolled run's terminal write). Only a CONFIRMED absent residency returns undefined. Real Redis +
// Postgres; the hot (non-forceDurable) path keeps its never-throw contract.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  SnapshotWriteUnavailableError,
  TaskRunExecutionSnapshotStore,
} from "./taskRunExecutionSnapshotStore.js";
import { SnapshotResidencyResolver } from "./snapshotResidencyResolver.js";
import { snapshotKeys } from "./snapshotKeys.js";
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

describe("readSnapshotRoute forceDurable fail-closed (P3 correction)", () => {
  containerTest(
    "committed -> route, absent -> undefined, evicted redis-primary -> throw; hot path never throws",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const mk = (dial: () => "redis-only" | undefined) =>
        new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          resolveDial: dial,
          residencyResolver: new SnapshotResidencyResolver({
            store,
            taskRunExists: async (id) => (await prisma.taskRun.count({ where: { id } })) > 0,
          }),
          logicalRunStoreRoute: ROUTE,
        });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const writer = mk(() => "redis-only"); // births redis-primary
        const reader = mk(() => undefined); // a poll-lagging pod

        // committed -> the run's true redis-primary route, even though the reader's dial is undefined.
        const runId = generateInternalId();
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, generateInternalId()),
        });
        const route = await reader.readSnapshotRoute(runId, env.organizationId, {
          forceDurable: true,
        });
        expect(route?.residency).toBe("redis-primary");

        // absent (never enrolled) -> undefined, not a throw.
        expect(
          await reader.readSnapshotRoute(generateInternalId(), env.organizationId, {
            forceDurable: true,
          })
        ).toBeUndefined();

        // Evict the redis-primary state but keep its permanent residency marker: the resolver now
        // reports expired/error, which forceDurable must FAIL CLOSED on (pre-correction it returned
        // undefined and took the Postgres shortcut).
        const k = snapshotKeys(runId);
        const raw = createRedisClient(redisOptions, { onError: () => {} });
        await raw.del(k.e, k.idx, k.cur, k.seq);
        await raw.quit();

        const reader2 = mk(() => undefined); // fresh resolver, no cached committed
        await expect(
          reader2.readSnapshotRoute(runId, env.organizationId, { forceDurable: true })
        ).rejects.toThrow(SnapshotWriteUnavailableError);

        // The hot (non-forceDurable) path on a dial=undefined pod still returns undefined without
        // throwing — the fail-closed behavior is scoped to the background transition path.
        expect(await reader2.readSnapshotRoute(runId, env.organizationId)).toBeUndefined();
      } finally {
        await store.quit();
      }
    }
  );
});
