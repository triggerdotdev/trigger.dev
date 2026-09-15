// P6a: the decorator feeds a bounded metric sink from its own dispatch: transaction-sized write
// outcomes (written / forked / failed) and read source (redis / postgres). Real Postgres + Redis via
// the production classes; the metric sink is a pure recorder (no mocks). Inert (postgres) writes emit
// no write metric.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  type SnapshotDecoratorMetrics,
} from "./taskRunExecutionSnapshotStore.js";
import { SnapshotResidencyResolver } from "./snapshotResidencyResolver.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";

function recorder() {
  const writes: string[] = [];
  const reads: string[] = [];
  const metrics: SnapshotDecoratorMetrics = {
    recordWrite: (o) => writes.push(o),
    recordReadSource: (s) => reads.push(s),
  };
  return { writes, reads, metrics };
}
function realResolver(store: RedisSnapshotStore, prisma: PrismaClient) {
  return new SnapshotResidencyResolver({
    store,
    taskRunExists: async (id) => (await prisma.taskRun.count({ where: { id } })) > 0,
  });
}
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
function transitionInput(
  env: Awaited<ReturnType<typeof seedSnapshotEnvironment>>,
  runId: string,
  id: string,
  previousSnapshotId: string
) {
  return {
    id,
    createdAt: new Date(),
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING" as const, description: "started" },
    previousSnapshotId,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

describe("TaskRunExecutionSnapshotStore decorator metrics (P6a)", () => {
  containerTest(
    "records write outcomes and read source; inert writes emit nothing",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);

        // Mirrored writer (redis-read): writes go through prepare/finalize; reads serve from MemoryDB head.
        const m = recorder();
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-read",
          resolveDial: () => "redis-read",
          residencyResolver: realResolver(store, prisma),
          logicalRunStoreRoute: ROUTE,
          metrics: m.metrics,
        });

        const runId = generateInternalId();
        const birthId = generateInternalId();
        const t1 = generateInternalId();
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId),
        });
        await writer.createExecutionSnapshot(transitionInput(env, runId, t1, birthId));
        // Two committed mirrored writes.
        expect(m.writes).toEqual(["written", "written"]);

        // A read dispatches from MemoryDB (mirrored redis-read head).
        await writer.findLatestExecutionSnapshot(runId);
        expect(m.reads).toContain("redis");

        // A fork guard: a transition off a stale parent is rejected at prepare -> "forked".
        await expect(
          writer.createExecutionSnapshot(transitionInput(env, runId, generateInternalId(), birthId))
        ).rejects.toThrow();
        expect(m.writes).toContain("forked");

        // A thrown prepare -> "failed". Inject a throwing prepare on the real store instance.
        const f = recorder();
        const failStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        (failStore as unknown as { prepare: () => Promise<never> }).prepare = () => {
          throw new Error("prepare boom");
        };
        const failWriter = new TaskRunExecutionSnapshotStore(delegate, {
          store: failStore,
          mode: "redis-only",
          resolveDial: () => "redis-only",
          residencyResolver: realResolver(store, prisma),
          logicalRunStoreRoute: ROUTE,
          metrics: f.metrics,
        });
        const failRun = generateInternalId();
        await expect(
          failWriter.createRun({
            data: buildCreateRunData(failRun, env),
            snapshot: birthSnapshot(env, generateInternalId()),
          })
        ).rejects.toThrow();
        expect(f.writes).toEqual(["failed"]);
        await failStore.quit();

        // A finalize that applied nothing must FAIL CLOSED (F2), never report success: neither stale (a
        // newer token superseded) nor baseMissing (the delayed-finalize fail-closed outcome) publishes,
        // so the transaction throws and records "failed", never "written".
        for (const outcome of ["baseMissing", "stale"] as const) {
          const nw = recorder();
          const nwStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
          (nwStore as unknown as { finalize: () => Promise<{ outcome: string }> }).finalize =
            async () => ({
              outcome,
            });
          const nwWriter = new TaskRunExecutionSnapshotStore(delegate, {
            store: nwStore,
            mode: "redis-only",
            resolveDial: () => "redis-only",
            residencyResolver: realResolver(store, prisma),
            logicalRunStoreRoute: ROUTE,
            metrics: nw.metrics,
          });
          await expect(
            nwWriter.createRun({
              data: buildCreateRunData(generateInternalId(), env),
              snapshot: birthSnapshot(env, generateInternalId()),
            })
          ).rejects.toThrow();
          expect(nw.writes).not.toContain("written");
          expect(nw.writes).toContain("failed");
          await nwStore.quit();
        }

        // Inert (never-enrolled) writer: a postgres write emits NO write metric; a read source is postgres.
        const i = recorder();
        const inert = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "dual-write",
          resolveDial: () => undefined,
          residencyResolver: realResolver(store, prisma),
          logicalRunStoreRoute: ROUTE,
          metrics: i.metrics,
        });
        const inertRun = generateInternalId();
        const inertBirth = generateInternalId();
        await inert.createRun({
          data: buildCreateRunData(inertRun, env),
          snapshot: birthSnapshot(env, inertBirth),
        });
        expect(i.writes).toEqual([]); // inert postgres write: no snapshot-store write metric
        await inert.findLatestExecutionSnapshot(inertRun);
        expect(i.reads).toContain("postgres");
      } finally {
        await store.quit();
      }
    }
  );
});
