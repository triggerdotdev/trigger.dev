// DATETIME / MANUAL waitpoint co-location with the owning run (run-ops split).
//
// The bug: `wait.for`/`wait.until` (DATETIME) and wait-token (MANUAL) waitpoints over the ~5s
// checkpoint threshold hang a run-ops run forever. `createDateTimeWaitpoint`/`createManualWaitpoint`
// mint an ALWAYS-cuid WaitpointId, and the routing store routed the upsert by that id → #legacy,
// even though the owning run-ops run lives on #new. `blockRunWithWaitpoint` then writes its block edge
// on #new (routed by run id), but the CTE joins `Waitpoint` LOCALLY on #new — where the
// waitpoint does not exist — so it writes 0 edges and the run is never actually blocked nor resumed.
//
// The fix: thread the owning `runId` into `createDateTimeWaitpoint`/`createManualWaitpoint` and route
// the waitpoint upsert by that run id, co-locating the waitpoint with its run on #new, exactly like
// RUN waitpoints already co-locate via `completedByTaskRunId` and the block edge co-locates via the
// run id. RED before the fix (waitpoint on #legacy, 0 edges, never resumes); GREEN after (waitpoint
// on #new, edge resolves, run resumes after completion).

import {
  heteroRunOpsPostgresTest,
  network,
  redisContainer,
  redisOptions,
} from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  RoutingRunStore,
  WAITPOINT_KEY_TRANSACTION_POOL_SIZE,
  WaitpointKeyTransactionLane,
  registerWaitpointKeyTransactionLane,
  type CreateRunInput,
} from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { RunOpsPrismaClient } from "@internal/run-ops-database";
import { parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { expect, vi } from "vitest";
import { RunEngine } from "../index.js";
import { workerCatalog } from "../workerCatalog.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { registerTestKeyLane } from "./utils/keyedWaitpointTest.js";
import { makeEngine } from "./utils/storeRunWaitpointLifecycleFixtures.js";

const twoDbEngineTest = heteroRunOpsPostgresTest.extend<{
  redisContainer: any;
  redisOptions: any;
}>({
  network,
  redisContainer,
  redisOptions,
});

// run-ops id (v1 internal id, version "1" at index 25) → classified NEW → routed to the run-ops (#new) store.
const RUN_OPS_A = "k".repeat(24) + "01";
const RUN_OPS_B = "m".repeat(24) + "01";
const RUN_OPS_C = "n".repeat(24) + "01";
const RUN_OPS_D = "p".repeat(24) + "01";

function baseEngineOptions(redisOptions: any, prisma: any) {
  return {
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

async function seedControlPlaneEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `prod-${suffix}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
      maximumConcurrencyLimit: 10,
    },
  });
  return { organization, project, environment };
}

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "EXECUTING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "parent-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      runTags: [],
      queue: "task/parent-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

// Seed an EXECUTING run-ops run on #new (prisma17) via the routed store. Returns the env + run id.
async function seedExecutingRunOpsRun(
  prisma14: PrismaClient,
  router: RoutingRunStore,
  runId: string,
  suffix: string
) {
  const env = await seedControlPlaneEnv(prisma14, suffix);

  await router.createRun(
    buildCreateRunInput({
      runId,
      friendlyId: `run_${suffix}`,
      organizationId: env.organization.id,
      projectId: env.project.id,
      runtimeEnvironmentId: env.environment.id,
    })
  );

  const created = await router.findLatestExecutionSnapshot(runId);
  await router.createExecutionSnapshot(
    {
      run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
      snapshot: { executionStatus: "EXECUTING", description: "run executing" },
      previousSnapshotId: created!.id,
      environmentId: env.environment.id,
      environmentType: "PRODUCTION",
      projectId: env.project.id,
      organizationId: env.organization.id,
    },
    prisma14
  );

  return env;
}

function makeRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
  });
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

describe("DATETIME/MANUAL waitpoint co-location with the owning run (two physical DBs)", () => {
  // RED before fix: the DATETIME waitpoint created for a run-ops run lands on #legacy (routed by its
  // own cuid id), so the block edge (on #new) finds no local waitpoint and the run never blocks/resumes.
  // GREEN after: the waitpoint co-locates on #new, the edge resolves, and the run resumes once the
  // datetime waitpoint completes via the engine's finishWaitpoint timer.
  twoDbEngineTest(
    "createDateTimeWaitpoint co-locates the waitpoint on #new and the run resumes after completion",
    async ({ prisma14, prisma17, redisOptions }) => {
      const p14 = prisma14 as unknown as PrismaClient;
      const router = makeRouter(p14, prisma17);
      const engine = new RunEngine({ store: router, ...baseEngineOptions(redisOptions, prisma14) });

      try {
        const runId = `run_${RUN_OPS_A}`;
        const env = await seedExecutingRunOpsRun(p14, router, runId, "dta");

        // ~600ms out so the finishWaitpoint timer fires within the test window.
        const date = new Date(Date.now() + 600);
        const { waitpoint } = await engine.createDateTimeWaitpoint({
          runId,
          projectId: env.project.id,
          environmentId: env.environment.id,
          completedAfter: date,
        });

        // CO-LOCATION: the waitpoint must live on #new next to the run.
        const onNew = await prisma17.waitpoint.findUnique({ where: { id: waitpoint.id } });
        const onLegacy = await p14.waitpoint.findUnique({ where: { id: waitpoint.id } });
        expect(onNew).not.toBeNull(); // RED: null (routed to #legacy by cuid id-shape)
        expect(onLegacy).toBeNull(); // RED: the waitpoint is here instead

        // Block the run on it — the edge co-locates on #new and the CTE joins the local waitpoint.
        await engine.blockRunWithWaitpoint({
          runId,
          waitpoints: waitpoint.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
        });

        const edgesOnNew = await prisma17.taskRunWaitpoint.count({ where: { taskRunId: runId } });
        expect(edgesOnNew).toBe(1); // RED: 0 (no local waitpoint to join)

        const blocked = await engine.getRunExecutionData({ runId });
        expect(blocked?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // The finishWaitpoint timer completes the waitpoint and the run resumes to EXECUTING.
        await vi.waitFor(
          async () => {
            const ed = await engine.getRunExecutionData({ runId });
            expect(ed?.snapshot.executionStatus).toBe("EXECUTING");
          },
          { timeout: 10_000, interval: 100 }
        );

        const completed = await prisma17.waitpoint.findUnique({ where: { id: waitpoint.id } });
        expect(completed?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // MANUAL (wait-token) analog: the waitpoint co-locates with the owning run on #new, the run blocks,
  // and an explicit engine.completeWaitpoint resumes it.
  twoDbEngineTest(
    "createManualWaitpoint co-locates the token on #new and the run resumes after completeWaitpoint",
    async ({ prisma14, prisma17, redisOptions }) => {
      const p14 = prisma14 as unknown as PrismaClient;
      const router = makeRouter(p14, prisma17);
      const engine = new RunEngine({ store: router, ...baseEngineOptions(redisOptions, prisma14) });

      try {
        const runId = `run_${RUN_OPS_B}`;
        const env = await seedExecutingRunOpsRun(p14, router, runId, "mna");

        const { waitpoint } = await engine.createManualWaitpoint({
          runId,
          environmentId: env.environment.id,
          projectId: env.project.id,
        });

        const onNew = await prisma17.waitpoint.findUnique({ where: { id: waitpoint.id } });
        const onLegacy = await p14.waitpoint.findUnique({ where: { id: waitpoint.id } });
        expect(onNew).not.toBeNull(); // RED: null
        expect(onLegacy).toBeNull();

        await engine.blockRunWithWaitpoint({
          runId,
          waitpoints: waitpoint.id,
          projectId: env.project.id,
          organizationId: env.organization.id,
        });

        expect(await prisma17.taskRunWaitpoint.count({ where: { taskRunId: runId } })).toBe(1);
        expect((await engine.getRunExecutionData({ runId }))?.snapshot.executionStatus).toBe(
          "EXECUTING_WITH_WAITPOINTS"
        );

        await engine.completeWaitpoint({
          id: waitpoint.id,
          output: { value: '{"ok":true}', type: "application/json", isError: false },
        });

        await vi.waitFor(
          async () => {
            const ed = await engine.getRunExecutionData({ runId });
            expect(ed?.snapshot.executionStatus).toBe("EXECUTING");
          },
          { timeout: 10_000, interval: 100 }
        );
      } finally {
        await engine.quit();
      }
    }
  );

  // Idempotency-keyed path (no deferral). A DATETIME waitpoint created twice with the same
  // (env, idempotencyKey) for the SAME run dedups within the run's own store on #new — the second
  // call returns the cached #new-resident waitpoint, never a phantom #legacy row.
  twoDbEngineTest(
    "idempotency-keyed createDateTimeWaitpoint dedups within the owning run's store on #new",
    async ({ prisma14, prisma17, redisOptions }) => {
      const p14 = prisma14 as unknown as PrismaClient;
      const router = makeRouter(p14, prisma17);
      const engine = new RunEngine({ store: router, ...baseEngineOptions(redisOptions, prisma14) });

      try {
        const runId = `run_${RUN_OPS_C}`;
        const env = await seedExecutingRunOpsRun(p14, router, runId, "idem");
        const idempotencyKey = "dedup-key-1";
        const date = new Date(Date.now() + 60_000);

        const first = await engine.createDateTimeWaitpoint({
          runId,
          projectId: env.project.id,
          environmentId: env.environment.id,
          completedAfter: date,
          idempotencyKey,
        });
        expect(first.isCached).toBe(false);

        const second = await engine.createDateTimeWaitpoint({
          runId,
          projectId: env.project.id,
          environmentId: env.environment.id,
          completedAfter: date,
          idempotencyKey,
        });
        expect(second.isCached).toBe(true);
        expect(second.waitpoint.id).toBe(first.waitpoint.id);

        // Both the dedup probe and the create must target #new — exactly one row, and it is on #new.
        expect(
          await prisma17.waitpoint.findUnique({ where: { id: first.waitpoint.id } })
        ).not.toBeNull();
        expect(await p14.waitpoint.findUnique({ where: { id: first.waitpoint.id } })).toBeNull();
        expect(
          await prisma17.waitpoint.count({
            where: { environmentId: env.environment.id, idempotencyKey },
          })
        ).toBe(1);
        expect(
          await p14.waitpoint.count({
            where: { environmentId: env.environment.id, idempotencyKey },
          })
        ).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  // Idempotency-keyed MANUAL analog with the same per-run-DB dedup invariant.
  twoDbEngineTest(
    "idempotency-keyed createManualWaitpoint dedups within the owning run's store on #new",
    async ({ prisma14, prisma17, redisOptions }) => {
      const p14 = prisma14 as unknown as PrismaClient;
      const router = makeRouter(p14, prisma17);
      const engine = new RunEngine({ store: router, ...baseEngineOptions(redisOptions, prisma14) });

      try {
        const runId = `run_${RUN_OPS_D}`;
        const env = await seedExecutingRunOpsRun(p14, router, runId, "idemm");
        const idempotencyKey = "dedup-key-2";

        const first = await engine.createManualWaitpoint({
          runId,
          environmentId: env.environment.id,
          projectId: env.project.id,
          idempotencyKey,
        });
        expect(first.isCached).toBe(false);

        const second = await engine.createManualWaitpoint({
          runId,
          environmentId: env.environment.id,
          projectId: env.project.id,
          idempotencyKey,
        });
        expect(second.isCached).toBe(true);
        expect(second.waitpoint.id).toBe(first.waitpoint.id);

        expect(
          await prisma17.waitpoint.findUnique({ where: { id: first.waitpoint.id } })
        ).not.toBeNull();
        expect(await p14.waitpoint.findUnique({ where: { id: first.waitpoint.id } })).toBeNull();
        expect(
          await prisma17.waitpoint.count({
            where: { environmentId: env.environment.id, idempotencyKey },
          })
        ).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  twoDbEngineTest(
    "standalone keyed MANUAL token follows the idempotency key namespace of its placement",
    async ({ prisma14, prisma17, uri14, uri17, redisOptions }) => {
      const p14 = prisma14 as unknown as PrismaClient;
      // PostgresRunStore looks its key lane up when it is built, so register both first.
      const legacyLane = registerTestKeyLane(p14, uri14);
      const runOpsUrl = new URL(uri17);
      runOpsUrl.searchParams.set("connection_limit", String(WAITPOINT_KEY_TRANSACTION_POOL_SIZE));
      const runOpsLane = new WaitpointKeyTransactionLane(
        () =>
          new RunOpsPrismaClient({ datasources: { db: { url: runOpsUrl.toString() } } }) as never
      );
      registerWaitpointKeyTransactionLane(prisma17, runOpsLane);
      const router = makeRouter(p14, prisma17);
      const snapshots = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60000 });
      const store = new WaitpointStoreCoordinator({ redisOptions, terminalRetentionMs: 2000 });
      const flagged = await seedControlPlaneEnv(p14, "kflag");
      const unflagged = await seedControlPlaneEnv(p14, "kplain");
      let enabled = true;
      const engine = makeEngine(p14, redisOptions, {
        runStore: router,
        store,
        snapshotStore: snapshots,
        workerDisabled: true,
        isWaitpointStoreEnabled: (organizationId) =>
          organizationId === flagged.organization.id && enabled,
      });
      try {
        for (const env of [flagged, unflagged]) {
          const create = (idempotencyKey: string, standaloneResidency: "LEGACY" | "NEW") =>
            engine.createManualWaitpoint({
              environmentId: env.environment.id,
              projectId: env.project.id,
              organizationId: env.organization.id,
              idempotencyKey,
              standaloneResidency,
              standaloneStoreEligible: true,
            });
          const rows = async (id: string) => [
            await p14.waitpoint.count({ where: { id } }),
            await prisma17.waitpoint.count({ where: { id } }),
          ];
          for (const key of ["k1", "k2"]) {
            enabled = key === "k1";
            const first = await create(key, "LEGACY");
            enabled = true;
            for (const again of [await create(key, "NEW"), await create(key, "NEW")])
              expect(again).toMatchObject({
                isCached: true,
                waitpoint: { id: first.waitpoint.id },
              });
            if (env === flagged && key === "k1") {
              expect(parseWaitpointId(first.waitpoint.id)).toMatchObject({
                format: "b32hexW",
                type: "MANUAL",
              });
              expect(await rows(first.waitpoint.id)).toEqual([0, 0]);
            } else {
              expect(await rows(first.waitpoint.id)).toEqual([1, 0]);
            }
          }
        }

        // A token removed at retention does not lend its key to the other placement.
        const scope = {
          environmentId: flagged.environment.id,
          projectId: flagged.project.id,
          organizationId: flagged.organization.id,
        };
        const create = (standaloneResidency: "LEGACY" | "NEW") =>
          engine.createManualWaitpoint({
            ...scope,
            idempotencyKey: "k3",
            standaloneResidency,
            standaloneStoreEligible: true,
          });
        const removed = (await create("LEGACY")).waitpoint.id;
        await engine.completeWaitpoint({
          id: removed,
          organizationId: scope.organizationId,
          onlyIfPending: true,
          output: { value: "done", isError: false },
        });
        const job = await engine["worker"].getJob(`recoverDateTimeWaitpoint:${removed}`);
        const payload = workerCatalog.recoverDateTimeWaitpoint.schema.parse(job!.item);
        await vi.waitFor(() => engine.waitpointSystem.recoverDateTimeWaitpoint(payload), {
          timeout: 30_000,
          interval: 250,
        });
        await expect
          .poll(() => engine.getStoreDateTimeWaitpoint({ ...scope, waitpointId: removed }), {
            timeout: 30_000,
            interval: 100,
          })
          .toBeNull();
        // Its reservation outlives the record until the retirement job, which is not run here.
        expect(await store.readIdempotencyKey(`${scope.environmentId}:legacy`, "k3")).toBe(removed);
        const fresh = await create("NEW");
        expect(fresh.isCached).toBe(false);
        expect(fresh.waitpoint.id).not.toBe(removed);
      } finally {
        await engine.quit();
        await store.quit();
        await snapshots.quit();
        await legacyLane.close();
        await runOpsLane.close();
      }
    }
  );

  twoDbEngineTest(
    "the keyed store read finds a waiter under another placement only when W1 is on",
    async ({ prisma14, prisma17, uri14, uri17, redisOptions }) => {
      const p14 = prisma14 as unknown as PrismaClient;
      const legacyLane = registerTestKeyLane(p14, uri14);
      const runOpsUrl = new URL(uri17);
      runOpsUrl.searchParams.set("connection_limit", String(WAITPOINT_KEY_TRANSACTION_POOL_SIZE));
      const runOpsLane = new WaitpointKeyTransactionLane(
        () =>
          new RunOpsPrismaClient({ datasources: { db: { url: runOpsUrl.toString() } } }) as never
      );
      registerWaitpointKeyTransactionLane(prisma17, runOpsLane);
      const router = makeRouter(p14, prisma17);
      const snapshots = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60000 });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const flagged = await seedControlPlaneEnv(p14, "rflag");
      const unflagged = await seedControlPlaneEnv(p14, "rplain");
      const engine = makeEngine(p14, redisOptions, {
        runStore: router,
        store,
        snapshotStore: snapshots,
        workerDisabled: true,
        isWaitpointStoreEnabled: (organizationId) => organizationId === flagged.organization.id,
      });
      const out: Record<string, unknown> = {};
      try {
        for (const [name, env, eligible] of [
          ["flagged", flagged, true],
          ["unflagged", unflagged, false],
        ] as const) {
          const scope = {
            environmentId: env.environment.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
          };
          const idempotencyKey = "webhook-waiter:review-key";
          // Waiter created while the env's placement is LEGACY.
          const first = await engine.createManualWaitpoint({
            ...scope,
            idempotencyKey,
            tags: ["webhook:endpoint-a"],
            timeout: new Date(Date.now() + 3_600_000),
            standaloneResidency: "LEGACY",
            standaloneStoreEligible: eligible,
          });
          // The port's find after the placement changes to NEW: Postgres leg, then store leg.
          const pg = await router.findWaitpoint(
            { where: { environmentId: scope.environmentId, idempotencyKey } },
            undefined,
            { residency: "NEW" }
          );
          const storeNew = await engine.readExistingStoreDateTimeWaitpointByKey({
            ...scope,
            idempotencyKey,
            standaloneResidency: "NEW",
          });
          const storeNewEligible = await engine.readExistingStoreDateTimeWaitpointByKey({
            ...scope,
            idempotencyKey,
            standaloneResidency: "NEW",
            standaloneStoreEligible: eligible,
          });
          const storeLegacy = await engine.readExistingStoreDateTimeWaitpointByKey({
            ...scope,
            idempotencyKey,
            standaloneResidency: "LEGACY",
          });
          // The port's create after the placement change.
          const again = await engine.createManualWaitpoint({
            ...scope,
            idempotencyKey,
            tags: ["webhook:endpoint-b"],
            timeout: new Date(Date.now() + 3_600_000),
            standaloneResidency: "NEW",
            standaloneStoreEligible: eligible,
          });
          out[name] = {
            firstId: first.waitpoint.id,
            format: parseWaitpointId(first.waitpoint.id).format,
            pgFindAfterChange: pg?.id ?? null,
            storeFindAfterChange: storeNew?.id ?? null,
            eligibleFindAfterChange: storeNewEligible
              ? { id: storeNewEligible.id, tags: storeNewEligible.tags }
              : null,
            storeFindSamePlacement: storeLegacy?.id ?? null,
            createAfterChange: { id: again.waitpoint.id, isCached: again.isCached },
          };
        }
        const f = out.flagged as any;
        const u = out.unflagged as any;
        expect(f.format).toBe("b32hexW");
        expect(f.pgFindAfterChange).toBeNull();
        expect(f.storeFindSamePlacement).toBe(f.firstId);
        expect(f.storeFindAfterChange).toBeNull();
        expect(f.eligibleFindAfterChange).toEqual({ id: f.firstId, tags: ["webhook:endpoint-a"] });
        expect(f.createAfterChange).toEqual({ id: f.firstId, isCached: true });
        expect(u.pgFindAfterChange).toBe(u.firstId);
      } finally {
        await engine.quit();
        await store.quit();
        await snapshots.quit();
        await legacyLane.close();
        await runOpsLane.close();
      }
    }
  );
});
