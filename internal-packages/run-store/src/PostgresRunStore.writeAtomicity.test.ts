// Cross-DB WRITE ATOMICITY against the REAL dedicated split topology.
//
// Under the run-ops split, several engine operations that were atomic-by-`prisma.$transaction` in
// single-DB make TWO distinct RunStore writes (e.g. startAttempt + createExecutionSnapshot, or
// promotePendingVersionRuns + createExecutionSnapshot). When the run is ksuid (#new), `RoutingRunStore`
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

// ownerEngine classifies by internal-id LENGTH: 25 chars → cuid → LEGACY, 27 chars → ksuid → NEW.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / control-plane DB, full schema)
const KSUID_27 = "k".repeat(27); // → NEW (#new / dedicated run-ops DB, subset schema)

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

// Seed a ksuid run on #new (its create nests the initial RUN_CREATED snapshot) and return its ids.
async function seedKsuidRun(
  router: RunStore,
  prisma17: RunOpsPrismaClient,
  suffix: string
): Promise<{ runId: string; env: { project: { id: string }; environment: { id: string } } }> {
  const env = await seedEnvironment(prisma17, "dedicated", suffix);
  const runId = `run_${KSUID_27}`;
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
  // before the fix) on a ksuid run leave PARTIAL state on a mid-pair failure — the run is EXECUTING
  // but no EXECUTING snapshot exists. This is the regression vs single-DB.
  // ---------------------------------------------------------------------------------------------
  heteroRunOpsPostgresTest(
    "BROKEN baseline: two un-wrapped routed writes persist partial state on a mid-pair failure",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const { runId, env } = await seedKsuidRun(router, prisma17, "broken_atomic");

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
    "runInTransaction rolls back startAttempt when a failure is injected before the snapshot write (ksuid → #new)",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const { runId, env } = await seedKsuidRun(router, prisma17, "rollback_new");

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
    "runInTransaction commits BOTH writes atomically on success (ksuid → #new)",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const { runId, env } = await seedKsuidRun(router, prisma17, "commit_new");

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
