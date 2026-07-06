// Cross-DB WRITE ATOMICITY against the REAL dedicated split topology.
//
// Under the run-ops split, several engine operations that were atomic-by-`prisma.$transaction` in
// single-DB make TWO distinct RunStore writes (e.g. startAttempt + createExecutionSnapshot, or
// promotePendingVersionRuns + createExecutionSnapshot). When the run is run-ops id (#new), `RoutingRunStore`
// routes each write to the NEW store but DROPS the caller's control-plane `tx` — so the two writes
// execute as independent auto-commit statements on the NEW DB, OUTSIDE any shared transaction. A crash
// between them leaves partial state (a run EXECUTING with no matching snapshot; promoted-but-no-snapshot).
//
// `heteroRunOpsPostgresTest` gives the REAL production split: prisma17 = a real `RunOpsPrismaClient`
// over the @internal/run-ops-database SUBSET schema (#new), prisma14 = the full control-plane schema on
// a SEPARATE physical PG container (#legacy). No mocks.
//
// The first test EMPIRICALLY DEMONSTRATES the regression (two un-wrapped routed writes persist partial
// state on a mid-pair failure). The remaining tests prove `RoutingRunStore.runInTransaction(runId, fn)`
// wraps the co-resident multi-write unit in ONE `#new` transaction so a failure between the two writes
// rolls BOTH back — no partial state.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput, RunStore, RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies by the version char: no marker → cuid → LEGACY, v1 body → run-ops id → NEW.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / control-plane DB, full schema)
const NEW_ID_26 = "k".repeat(24) + "01"; // → NEW (#new / dedicated run-ops DB, subset schema)

async function seedEnvironment(
  prisma: AnyClient,
  schemaVariant: RunStoreSchemaVariant,
  suffix: string
) {
  if (schemaVariant === "dedicated") {
    return {
      organization: { id: `org_${suffix}` },
      project: { id: `proj_${suffix}` },
      environment: { id: `env_${suffix}` },
    };
  }
  const organization = await (prisma as PrismaClient).organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await (prisma as PrismaClient).project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await (prisma as PrismaClient).runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
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
      status: "PENDING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      traceContext: { trace: "ctx" },
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      runTags: [],
      queue: "task/my-task",
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
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

function makeDedicatedStore(prisma17: RunOpsPrismaClient) {
  return new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
}

function makeLegacyStore(prisma14: PrismaClient) {
  return new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
  });
}

function makeSplitRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyStore = makeLegacyStore(prisma14);
  const newStore = makeDedicatedStore(prisma17);
  return {
    router: new RoutingRunStore({ new: newStore, legacy: legacyStore }),
    legacyStore,
    newStore,
  };
}

// Seed a run-ops run on #new (its create nests the initial RUN_CREATED snapshot) and return its ids.
async function seedRunOpsRun(
  router: RunStore,
  prisma17: RunOpsPrismaClient,
  suffix: string
): Promise<{ runId: string; env: { project: { id: string }; environment: { id: string } } }> {
  const env = await seedEnvironment(prisma17, "dedicated", suffix);
  const runId = `run_${NEW_ID_26}`;
  await router.createRun(
    buildCreateRunInput({
      runId,
      friendlyId: `run_${suffix}`,
      organizationId: env.organization.id,
      projectId: env.project.id,
      runtimeEnvironmentId: env.environment.id,
    })
  );
  return { runId, env };
}

const ATTEMPT_SELECT = { id: true, status: true, attemptNumber: true } as const;

function snapshotInput(
  runId: string,
  env: { project: { id: string }; environment: { id: string } }
) {
  return {
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING" as const, description: "Attempt created, starting" },
    environmentId: env.environment.id,
    environmentType: "DEVELOPMENT" as const,
    projectId: env.project.id,
    organizationId: env.project.id,
  };
}

describe("cross-DB write atomicity (startAttempt + createExecutionSnapshot)", () => {
  // ---------------------------------------------------------------------------------------------
  // RED demonstration: the BROKEN behaviour. Two separate routed writes (as the engine made them
  // before the fix) on a run-ops run leave PARTIAL state on a mid-pair failure — the run is EXECUTING
  // but no EXECUTING snapshot exists. This is the regression vs single-DB.
  // ---------------------------------------------------------------------------------------------
  heteroRunOpsPostgresTest(
    "BROKEN baseline: two un-wrapped routed writes persist partial state on a mid-pair failure",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const { runId, env } = await seedRunOpsRun(router, prisma17, "broken_atomic");

      // Simulate the OLD engine pattern: startAttempt then a failure BEFORE createExecutionSnapshot,
      // each as an independent routed (auto-commit) write — no shared transaction.
      await expect(
        (async () => {
          await router.startAttempt(
            runId,
            { attemptNumber: 1, executedAt: new Date(), isWarmStart: false },
            { select: ATTEMPT_SELECT }
          );
          throw new Error("boom between writes");
          // eslint-disable-next-line no-unreachable
          await router.createExecutionSnapshot(snapshotInput(runId, env));
        })()
      ).rejects.toThrow("boom between writes");

      // The first write was auto-committed: the run is EXECUTING but there is NO EXECUTING snapshot.
      const run = await prisma17.taskRun.findFirstOrThrow({ where: { id: runId } });
      expect(run.status).toBe("EXECUTING"); // partial state PERSISTED — the bug
      const execSnap = await prisma17.taskRunExecutionSnapshot.findFirst({
        where: { runId, executionStatus: "EXECUTING" },
      });
      expect(execSnap).toBeNull(); // no snapshot → run executing without a snapshot
    }
  );

  // ---------------------------------------------------------------------------------------------
  // FIX: runInTransaction wraps the co-resident multi-write unit in ONE #new transaction. A failure
  // BETWEEN the two writes rolls the FIRST write back — no partial state.
  // ---------------------------------------------------------------------------------------------
  heteroRunOpsPostgresTest(
    "runInTransaction rolls back startAttempt when a failure is injected before the snapshot write (run-ops id → #new)",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const { runId, env } = await seedRunOpsRun(router, prisma17, "rollback_new");

      await expect(
        router.runInTransaction(runId, async (store, tx) => {
          await store.startAttempt(
            runId,
            { attemptNumber: 1, executedAt: new Date(), isWarmStart: false },
            { select: ATTEMPT_SELECT },
            tx
          );
          // Inject the failure AFTER the first write, BEFORE the snapshot write.
          throw new Error("boom between writes");
          // eslint-disable-next-line no-unreachable
          await store.createExecutionSnapshot(snapshotInput(runId, env), tx);
        })
      ).rejects.toThrow("boom between writes");

      // Both writes rolled back: run is still PENDING and no EXECUTING snapshot exists.
      const run = await prisma17.taskRun.findFirstOrThrow({ where: { id: runId } });
      expect(run.status).toBe("PENDING");
      expect(run.attemptNumber).toBeNull();
      const execSnap = await prisma17.taskRunExecutionSnapshot.findFirst({
        where: { runId, executionStatus: "EXECUTING" },
      });
      expect(execSnap).toBeNull();
    }
  );

  heteroRunOpsPostgresTest(
    "runInTransaction commits BOTH writes atomically on success (run-ops id → #new)",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const { runId, env } = await seedRunOpsRun(router, prisma17, "commit_new");

      const result = await router.runInTransaction(runId, async (store, tx) => {
        const run = await store.startAttempt(
          runId,
          { attemptNumber: 1, executedAt: new Date(), isWarmStart: false },
          { select: ATTEMPT_SELECT },
          tx
        );
        const snapshot = await store.createExecutionSnapshot(snapshotInput(runId, env), tx);
        return { run, snapshot };
      });

      expect(result.run.status).toBe("EXECUTING");
      expect(result.snapshot.executionStatus).toBe("EXECUTING");

      // Both persisted on #new.
      const run = await prisma17.taskRun.findFirstOrThrow({ where: { id: runId } });
      expect(run.status).toBe("EXECUTING");
      expect(run.attemptNumber).toBe(1);
      const execSnap = await prisma17.taskRunExecutionSnapshot.findFirst({
        where: { runId, executionStatus: "EXECUTING" },
      });
      expect(execSnap).not.toBeNull();
    }
  );

  // The same atomic guarantee for a cuid run on #legacy — the owning store is #legacy and the inner
  // writes share its transaction.
  heteroRunOpsPostgresTest(
    "runInTransaction rolls back BOTH writes on a cuid run (#legacy)",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma14, "legacy", "rollback_leg");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: `run_rollback_leg`,
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );

      await expect(
        router.runInTransaction(runId, async (store, tx) => {
          await store.startAttempt(
            runId,
            { attemptNumber: 1, executedAt: new Date(), isWarmStart: false },
            { select: ATTEMPT_SELECT },
            tx
          );
          throw new Error("boom between writes");
        })
      ).rejects.toThrow("boom between writes");

      const run = await prisma14.taskRun.findFirstOrThrow({ where: { id: runId } });
      expect(run.status).toBe("PENDING");
      expect(run.attemptNumber).toBeNull();
    }
  );
});

// A run's blocking edges may straddle both DBs mid-drain, so clearBlockingWaitpoints routes the
// taskRunId-keyed delete through the both-stores fan-out. The #new leg can't join a control-plane
// tx, but the #legacy leg CAN — so the caller's tx (e.g. attemptFailed) must still be honored for
// the legacy edges, keeping them atomic with the caller's operation instead of auto-committing.
async function seedLegacyBlockingEdge(
  prisma14: PrismaClient,
  env: { project: { id: string }; environment: { id: string } },
  runId: string,
  suffix: string
): Promise<void> {
  const waitpoint = await prisma14.waitpoint.create({
    data: {
      friendlyId: `wp_${suffix}`,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: `idem_${suffix}`,
      userProvidedIdempotencyKey: false,
      projectId: env.project.id,
      environmentId: env.environment.id,
    },
  });
  await prisma14.taskRunWaitpoint.create({
    data: { taskRunId: runId, waitpointId: waitpoint.id, projectId: env.project.id },
  });
}

describe("fan-out deleteManyTaskRunWaitpoints honors the caller's tx on the #legacy leg", () => {
  heteroRunOpsPostgresTest(
    "rolls the #legacy edge delete back when the caller's control-plane tx rolls back",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma14, "legacy", "del_tx_rb");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_del_tx_rb",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );
      await seedLegacyBlockingEdge(prisma14, env, runId, "del_tx_rb");

      await expect(
        prisma14.$transaction(async (tx) => {
          await router.deleteManyTaskRunWaitpoints({ where: { taskRunId: runId } }, tx);
          throw new Error("rollback");
        })
      ).rejects.toThrow("rollback");

      const remaining = await prisma14.taskRunWaitpoint.count({ where: { taskRunId: runId } });
      expect(remaining).toBe(1);
    }
  );

  heteroRunOpsPostgresTest(
    "still deletes the #legacy edge when the caller's tx commits",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma14, "legacy", "del_tx_commit");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_del_tx_commit",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );
      await seedLegacyBlockingEdge(prisma14, env, runId, "del_tx_commit");

      await prisma14.$transaction(async (tx) => {
        await router.deleteManyTaskRunWaitpoints({ where: { taskRunId: runId } }, tx);
      });

      const remaining = await prisma14.taskRunWaitpoint.count({ where: { taskRunId: runId } });
      expect(remaining).toBe(0);
    }
  );
});

// createExecutionSnapshot writes the snapshot row and its completed-waitpoint join rows. These MUST
// commit together: with the flag off, `/snapshots/since` is served from a lagging read replica, so a
// snapshot that commits before its `_completedWaitpoints` rows can be read waitpoint-less, and the
// runner's EXECUTING branch no-ops on an empty completedWaitpoints -> the resume is lost -> hang.
describe("createExecutionSnapshot writes the snapshot and its completed-waitpoint links atomically", () => {
  heteroRunOpsPostgresTest(
    "rolls the snapshot back if the completed-waitpoint insert fails (no waitpoint-less snapshot persists)",
    async ({ prisma14 }) => {
      const legacy = makeLegacyStore(prisma14);
      const env = await seedEnvironment(prisma14, "legacy", "ces_atomic");
      const runId = `run_${CUID_25}`;
      await legacy.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_ces_atomic",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );
      const waitpoint = await prisma14.waitpoint.create({
        data: {
          friendlyId: "wp_ces_atomic",
          type: "MANUAL",
          status: "COMPLETED",
          idempotencyKey: "idem-ces_atomic",
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });

      // Force the completed-waitpoint join insert to fail mid-write.
      await prisma14.$executeRawUnsafe('DROP TABLE "_completedWaitpoints"');

      await expect(
        // Pass the base client as `tx` - exactly how the engine threads its base prisma through
        // (continueRunIfUnblocked -> executionSnapshotSystem.createExecutionSnapshot(prisma, ...)).
        // It is NOT an interactive transaction, so the store must still open its own to stay atomic.
        legacy.createExecutionSnapshot(
          {
            run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
            snapshot: {
              executionStatus: "EXECUTING_WITH_WAITPOINTS",
              description: "Run was blocked by a waitpoint.",
            },
            environmentId: env.environment.id,
            environmentType: "DEVELOPMENT",
            projectId: env.project.id,
            organizationId: env.project.id,
            completedWaitpoints: [{ id: waitpoint.id, index: 0 }],
          },
          prisma14
        )
      ).rejects.toThrow();

      // The snapshot must NOT persist without its links, or a replica can serve it waitpoint-less.
      const snap = await prisma14.taskRunExecutionSnapshot.findFirst({
        where: { runId, executionStatus: "EXECUTING_WITH_WAITPOINTS" },
      });
      expect(snap).toBeNull();
    }
  );
});

// RoutingRunStore.createExecutionSnapshot accepts a caller tx but must forward it to the OWNING store
// only when that store is #legacy: a control-plane tx can't wrap a #new (cross-DB) write, but it can
// (and should) wrap a legacy-resident snapshot so it stays atomic with the caller's operation.
describe("createExecutionSnapshot honors the caller's tx on the #legacy owning store", () => {
  heteroRunOpsPostgresTest(
    "rolls the snapshot back when a legacy run's caller tx rolls back",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma14, "legacy", "ces_rb");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_ces_rb",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );

      await expect(
        prisma14.$transaction(async (tx) => {
          await router.createExecutionSnapshot(snapshotInput(runId, env), tx);
          throw new Error("rollback");
        })
      ).rejects.toThrow("rollback");

      const snap = await prisma14.taskRunExecutionSnapshot.findFirst({
        where: { runId, executionStatus: "EXECUTING" },
      });
      expect(snap).toBeNull();
    }
  );

  heteroRunOpsPostgresTest(
    "persists the snapshot when the legacy caller tx commits",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma14, "legacy", "ces_commit");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_ces_commit",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );

      await prisma14.$transaction(async (tx) => {
        await router.createExecutionSnapshot(snapshotInput(runId, env), tx);
      });

      const snap = await prisma14.taskRunExecutionSnapshot.findFirst({
        where: { runId, executionStatus: "EXECUTING" },
      });
      expect(snap).not.toBeNull();
    }
  );
});

// On the dedicated subset schema the associated (RUN-type) waitpoint is created as a SEPARATE
// waitpoint.create after taskRun.create (the legacy schema nests it atomically). The pair must commit
// together, or a crash / lagging read leaves a run with no completion waitpoint and its parent never resumes.
function assocWaitpoint(
  env: { project: { id: string }; environment: { id: string } },
  suffix: string
) {
  return {
    id: `wp_${suffix}`,
    friendlyId: `waitpoint_${suffix}`,
    type: "RUN" as const,
    status: "PENDING" as const,
    idempotencyKey: `idem_${suffix}`,
    userProvidedIdempotencyKey: false,
    projectId: env.project.id,
    environmentId: env.environment.id,
  };
}

describe("createRun / createFailedRun write the run and its associated waitpoint atomically (dedicated)", () => {
  heteroRunOpsPostgresTest(
    "createRun rolls the run back if the associated-waitpoint create fails",
    async ({ prisma17 }) => {
      const newStore = makeDedicatedStore(prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "cr_atomic");
      const runId = `run_${NEW_ID_26}`;
      const input = {
        ...buildCreateRunInput({
          runId,
          friendlyId: "run_cr_atomic",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        }),
        associatedWaitpoint: assocWaitpoint(env, "cr_atomic"),
      };

      // Force #createAssociatedWaitpoint (waitpoint.create) to fail after taskRun.create.
      await prisma17.$executeRawUnsafe('DROP TABLE "Waitpoint"');

      await expect(newStore.createRun(input)).rejects.toThrow();

      const run = await prisma17.taskRun.findFirst({ where: { id: runId } });
      expect(run).toBeNull();
    }
  );

  heteroRunOpsPostgresTest(
    "createFailedRun rolls the run back if the associated-waitpoint create fails",
    async ({ prisma17 }) => {
      const newStore = makeDedicatedStore(prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "cf_atomic");
      const runId = `run_${NEW_ID_26}`;
      const base = buildCreateRunInput({
        runId,
        friendlyId: "run_cf_atomic",
        organizationId: env.organization.id,
        projectId: env.project.id,
        runtimeEnvironmentId: env.environment.id,
      });
      const input = { data: base.data, associatedWaitpoint: assocWaitpoint(env, "cf_atomic") };

      await prisma17.$executeRawUnsafe('DROP TABLE "Waitpoint"');

      await expect(newStore.createFailedRun(input)).rejects.toThrow();

      const run = await prisma17.taskRun.findFirst({ where: { id: runId } });
      expect(run).toBeNull();
    }
  );
});

// The dedicated (#new) leg connects completed waitpoints through the `CompletedWaitpoint` join table
// (createMany), where the legacy leg uses the implicit `_completedWaitpoints` M2M. Both must commit the
// snapshot and its links together: a snapshot that commits before its links can be read waitpoint-less
// from a lagging replica, and the runner's EXECUTING branch no-ops on an empty set -> the resume hangs.
describe("createExecutionSnapshot / lockRunToWorker write the snapshot and its links atomically (dedicated)", () => {
  heteroRunOpsPostgresTest(
    "createExecutionSnapshot rolls the snapshot back if the CompletedWaitpoint insert fails",
    async ({ prisma17 }) => {
      const newStore = makeDedicatedStore(prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "ces_ded");
      const runId = `run_${NEW_ID_26}`;
      await newStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_ces_ded",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );

      // Force the dedicated join insert (completedWaitpoint.createMany) to fail mid-write.
      await prisma17.$executeRawUnsafe('DROP TABLE "CompletedWaitpoint"');

      await expect(
        // Base client as `tx` = how the engine threads its base prisma through
        // (continueRunIfUnblocked -> executionSnapshotSystem.createExecutionSnapshot(prisma, ...)).
        // It is NOT an interactive transaction, so the store must still open its own to stay atomic.
        newStore.createExecutionSnapshot(
          {
            run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
            snapshot: {
              executionStatus: "EXECUTING_WITH_WAITPOINTS",
              description: "Run was blocked by a waitpoint.",
            },
            environmentId: env.environment.id,
            environmentType: "DEVELOPMENT",
            projectId: env.project.id,
            organizationId: env.project.id,
            completedWaitpoints: [{ id: `wp_${NEW_ID_26}`, index: 0 }],
          },
          prisma17 as never
        )
      ).rejects.toThrow();

      const snap = await prisma17.taskRunExecutionSnapshot.findFirst({
        where: { runId, executionStatus: "EXECUTING_WITH_WAITPOINTS" },
      });
      expect(snap).toBeNull();
    }
  );

  heteroRunOpsPostgresTest(
    "lockRunToWorker rolls the snapshot and run lock back if the CompletedWaitpoint insert fails",
    async ({ prisma17 }) => {
      const newStore = makeDedicatedStore(prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "lock_ded");
      const runId = `run_${NEW_ID_26}`;
      await newStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_lock_ded",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );
      const prior = await prisma17.taskRunExecutionSnapshot.findFirstOrThrow({ where: { runId } });

      await prisma17.$executeRawUnsafe('DROP TABLE "CompletedWaitpoint"');

      const snapshotId = `snap_${NEW_ID_26}`;
      await expect(
        // lockedById/lockedToVersionId/lockedQueueId are FK-free scalars on the dedicated subset, so
        // synthetic ids are fine; the base client as `tx` mirrors the dequeue path (no interactive tx).
        newStore.lockRunToWorker(
          runId,
          {
            lockedAt: new Date(),
            lockedById: `bwt_${NEW_ID_26}`,
            lockedToVersionId: `bw_${NEW_ID_26}`,
            lockedQueueId: `queue_${NEW_ID_26}`,
            startedAt: new Date(),
            baseCostInCents: 5,
            machinePreset: "small-1x",
            taskVersion: "20260601.1",
            sdkVersion: "3.0.0",
            cliVersion: "3.0.0",
            maxDurationInSeconds: null,
            snapshot: {
              id: snapshotId,
              previousSnapshotId: prior.id,
              environmentId: env.environment.id,
              environmentType: "DEVELOPMENT",
              projectId: env.project.id,
              organizationId: env.project.id,
              completedWaitpointIds: [`wp_${NEW_ID_26}`],
              completedWaitpointOrder: [`wp_${NEW_ID_26}`],
            },
          },
          prisma17 as never
        )
      ).rejects.toThrow();

      const snap = await prisma17.taskRunExecutionSnapshot.findUnique({
        where: { id: snapshotId },
      });
      expect(snap).toBeNull();
      // The whole lock write must roll back, not just the status: no lock columns may leak through.
      const run = await prisma17.taskRun.findUniqueOrThrow({ where: { id: runId } });
      expect(run.status).not.toBe("DEQUEUED");
      expect(run.lockedAt).toBeNull();
      expect(run.lockedById).toBeNull();
      expect(run.lockedToVersionId).toBeNull();
      expect(run.lockedQueueId).toBeNull();
    }
  );
});
