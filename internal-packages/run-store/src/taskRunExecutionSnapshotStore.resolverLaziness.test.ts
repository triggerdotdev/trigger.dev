// Laziness of the completed-waitpoint resolver thunk: it must be invoked ONLY when a fresh
// redis-primary cycle is being built. A postgres transition returns before the cycle seam, and a
// mirrored transition builds no fresh cycle, so neither may call the thunk — that is what keeps the
// MemoryDB record read (and any Postgres widening it does) off every ordinary transition. Proven end
// to end against real Postgres + real Redis, driving the production decorator at each residency.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreDial,
} from "./taskRunExecutionSnapshotStore.js";
import { SnapshotResidencyResolver } from "./snapshotResidencyResolver.js";
import { buildCompletedWaitpointRecords } from "../../run-engine/src/engine/systems/completedWaitpointResolver.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";

function birthSnapshot(env: Awaited<ReturnType<typeof seedSnapshotEnvironment>>, id: string) {
  return {
    id,
    createdAt: new Date(),
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

function realResolver(store: RedisSnapshotStore) {
  return new SnapshotResidencyResolver({
    store,
  });
}

describe("completed-waitpoint resolver laziness", () => {
  containerTest(
    "the resolver thunk is called only for a fresh redis-primary cycle, never for postgres or mirrored",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      try {
        // A birth at each residency: off => inert postgres, dual-write => mirrored, redis-only =>
        // redis-primary. The number is the expected resolver invocations on the following transition.
        const cases: Array<{ dial: SnapshotStoreDial; expected: number }> = [
          { dial: "off", expected: 0 },
          { dial: "dual-write", expected: 0 },
          { dial: "redis-only", expected: 1 },
        ];

        for (const c of cases) {
          const env = await seedSnapshotEnvironment(prisma);
          const runId = generateInternalId();
          const birthId = generateInternalId();
          const transitionId = generateInternalId();

          const writer = new TaskRunExecutionSnapshotStore(delegate, {
            store,
            mode: c.dial === "redis-only" ? "redis-only" : "dual-write",
            resolveDial: () => c.dial,
            residencyResolver: realResolver(store),
            logicalRunStoreRoute: ROUTE,
          });

          await writer.createRun({
            data: buildCreateRunData(runId, env),
            snapshot: birthSnapshot(env, birthId),
          });

          // A real completed Waitpoint row: the postgres and mirrored transitions connect it in the
          // Postgres join (FK-constrained), so it must exist for those legs to reach the cycle seam.
          const waitpointId = generateInternalId();
          await prisma.waitpoint.create({
            data: {
              id: waitpointId,
              friendlyId: `waitpoint_${waitpointId}`,
              type: "MANUAL",
              status: "COMPLETED",
              completedAt: new Date("2026-08-21T12:00:00.000Z"),
              idempotencyKey: `idem_${waitpointId}`,
              userProvidedIdempotencyKey: false,
              projectId: env.projectId,
              environmentId: env.id,
            },
          });
          let resolverCalls = 0;

          await writer.createExecutionSnapshot({
            id: transitionId,
            createdAt: new Date(),
            run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
            snapshot: { executionStatus: "EXECUTING" as const, description: "resumed" },
            previousSnapshotId: birthId,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
            completedWaitpoints: [{ id: waitpointId }],
            resolveCompletedWaitpointRecords: async () => {
              resolverCalls++;
              return buildCompletedWaitpointRecords(
                await delegate.findManyWaitpoints({
                  where: { id: waitpointId, status: "COMPLETED" },
                })
              );
            },
          });

          expect(resolverCalls, `dial=${c.dial}`).toBe(c.expected);
        }
      } finally {
        await store.quit();
      }
    }
  );
});
