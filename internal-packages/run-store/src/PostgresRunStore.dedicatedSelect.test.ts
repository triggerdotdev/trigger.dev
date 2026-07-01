import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import type {
  CreateRunInput,
  RunAssociatedWaitpointInput,
  RunStoreSchemaVariant,
} from "./types.js";

// The store's structural client accepts either backing Prisma client; the two generated
// clients are nominally distinct so we widen at the boundary, exactly as buildRunStore does.
type AnyClient = PrismaClient | RunOpsPrismaClient;

// On the dedicated subset schema there are no Organization/Project/RuntimeEnvironment models and
// the run-ops rows carry FK-free scalar ids, so we mint synthetic ids; on legacy we seed the real
// owning rows the FKs require.
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

function buildAssociatedWaitpoint(params: {
  id: string;
  friendlyId: string;
  projectId: string;
  environmentId: string;
}): RunAssociatedWaitpointInput {
  return {
    id: params.id,
    friendlyId: params.friendlyId,
    type: "RUN",
    status: "PENDING",
    idempotencyKey: `idem_${params.id}`,
    userProvidedIdempotencyKey: false,
    projectId: params.projectId,
    environmentId: params.environmentId,
  };
}

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  associatedWaitpoint?: RunAssociatedWaitpointInput;
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
      context: { foo: "bar" },
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
    associatedWaitpoint: params.associatedWaitpoint,
  };
}

async function seedPendingWaitpoint(
  prisma: AnyClient,
  params: { id: string; friendlyId: string; projectId: string; environmentId: string }
) {
  return (prisma as PrismaClient).waitpoint.create({
    data: {
      id: params.id,
      friendlyId: params.friendlyId,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: `idem_${params.id}`,
      userProvidedIdempotencyKey: false,
      projectId: params.projectId,
      environmentId: params.environmentId,
    },
  });
}

function makeStore(prisma: AnyClient, schemaVariant: RunStoreSchemaVariant) {
  return new PostgresRunStore({
    prisma: prisma as never,
    readOnlyPrisma: prisma as never,
    schemaVariant,
  });
}

// --- group-A on TaskRun: associatedWaitpoint -------------------------------------------------

// Runs the run-engine-shaped completeAttemptSuccess call: a caller select that includes the
// group-A `associatedWaitpoint` relation key, exactly as runAttemptSystem does.
async function runAssociatedWaitpointScenario(
  prisma: AnyClient,
  schemaVariant: RunStoreSchemaVariant,
  suffix: string
) {
  const store = makeStore(prisma, schemaVariant);
  const env = await seedEnvironment(prisma, schemaVariant, suffix);
  const runId = `run_${suffix}`;
  const waitpointId = `wp_assoc_${suffix}`;

  await store.createRun(
    buildCreateRunInput({
      runId,
      friendlyId: `run_friendly_${suffix}`,
      organizationId: env.organization.id,
      projectId: env.project.id,
      runtimeEnvironmentId: env.environment.id,
      associatedWaitpoint: buildAssociatedWaitpoint({
        id: waitpointId,
        friendlyId: `waitpoint_assoc_${suffix}`,
        projectId: env.project.id,
        environmentId: env.environment.id,
      }),
    })
  );

  // The actual run-engine call shape (runAttemptSystem.completeRunAttemptSuccess).
  const completed = await store.completeAttemptSuccess(
    runId,
    {
      completedAt: new Date(),
      output: '{"done":true}',
      outputType: "application/json",
      usageDurationMs: 100,
      costInCents: 1,
      snapshot: {
        executionStatus: "FINISHED",
        description: "Attempt succeeded",
        runStatus: "COMPLETED_SUCCESSFULLY",
        attemptNumber: 1,
        environmentId: env.environment.id,
        environmentType: "DEVELOPMENT",
        projectId: env.project.id,
        organizationId: env.organization.id,
      },
    },
    {
      select: {
        id: true,
        status: true,
        associatedWaitpoint: {
          select: { id: true },
        },
      },
    }
  );

  // findRun with the same group-A select (the read path).
  const found = await store.findRun(
    { id: runId },
    { select: { id: true, associatedWaitpoint: { select: { id: true } } } }
  );

  return { runId, waitpointId, completed, found };
}

// --- group-A on TaskRunExecutionSnapshot: completedWaitpoints --------------------------------

async function runCompletedWaitpointsScenario(
  prisma: AnyClient,
  schemaVariant: RunStoreSchemaVariant,
  suffix: string
) {
  const store = makeStore(prisma, schemaVariant);
  const env = await seedEnvironment(prisma, schemaVariant, suffix);
  const runId = `run_${suffix}`;

  await store.createRun(
    buildCreateRunInput({
      runId,
      friendlyId: `run_friendly_${suffix}`,
      organizationId: env.organization.id,
      projectId: env.project.id,
      runtimeEnvironmentId: env.environment.id,
    })
  );

  const w1 = `wp_${suffix}_1`;
  const w2 = `wp_${suffix}_2`;
  await seedPendingWaitpoint(prisma, {
    id: w1,
    friendlyId: `waitpoint_${suffix}_1`,
    projectId: env.project.id,
    environmentId: env.environment.id,
  });
  await seedPendingWaitpoint(prisma, {
    id: w2,
    friendlyId: `waitpoint_${suffix}_2`,
    projectId: env.project.id,
    environmentId: env.environment.id,
  });

  const snapshot = await store.createExecutionSnapshot({
    run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING_WITH_WAITPOINTS", description: "with waitpoints" },
    completedWaitpoints: [
      { id: w2, index: 1 },
      { id: w1, index: 0 },
    ],
    environmentId: env.environment.id,
    environmentType: "DEVELOPMENT",
    projectId: env.project.id,
    organizationId: env.organization.id,
  });

  // The run-engine call shape for fetching a snapshot's completed waitpoints.
  const fetched = await store.findExecutionSnapshot({
    where: { id: snapshot.id },
    include: { completedWaitpoints: true },
  });

  return { snapshotId: snapshot.id, w1, w2, fetched };
}

// --- connection back-ref on Waitpoint: blockingTaskRuns --------------------------------------

async function runBlockingTaskRunsScenario(
  prisma: AnyClient,
  schemaVariant: RunStoreSchemaVariant,
  suffix: string
) {
  const store = makeStore(prisma, schemaVariant);
  const env = await seedEnvironment(prisma, schemaVariant, suffix);
  const runId = `run_${suffix}`;
  const waitpointId = `wp_block_${suffix}`;

  await store.createRun(
    buildCreateRunInput({
      runId,
      friendlyId: `run_friendly_${suffix}`,
      organizationId: env.organization.id,
      projectId: env.project.id,
      runtimeEnvironmentId: env.environment.id,
    })
  );
  await seedPendingWaitpoint(prisma, {
    id: waitpointId,
    friendlyId: `waitpoint_block_${suffix}`,
    projectId: env.project.id,
    environmentId: env.environment.id,
  });

  // Block the run on the waitpoint (writes the TaskRunWaitpoint block edge + connection).
  await store.blockRunWithWaitpointEdges({
    runId,
    waitpointIds: [waitpointId],
    projectId: env.project.id,
  });

  // The run-engine call shape (engine.getWaitpoint).
  const waitpoint = await store.findWaitpoint({
    where: { id: waitpointId },
    include: {
      blockingTaskRuns: {
        select: {
          taskRun: {
            select: { id: true, friendlyId: true },
          },
        },
      },
    },
  });

  return { runId, waitpointId, waitpoint, friendlyId: `run_friendly_${suffix}` };
}

describe("PostgresRunStore dedicated caller-select adapter (P2-store-bodies-2)", () => {
  // associatedWaitpoint (TaskRun group-A) — RED on dedicated before this task, GREEN after.
  heteroRunOpsPostgresTest(
    "completeAttemptSuccess + findRun honor associatedWaitpoint on the DEDICATED client",
    async ({ prisma17 }) => {
      const r = await runAssociatedWaitpointScenario(prisma17, "dedicated", "ded_aw");

      expect(r.completed.id).toBe(r.runId);
      expect(r.completed.status).toBe("COMPLETED_SUCCESSFULLY");
      // honor the caller sub-select { id: true } only
      expect(r.completed.associatedWaitpoint).not.toBeNull();
      expect(r.completed.associatedWaitpoint!.id).toBe(r.waitpointId);
      expect(Object.keys(r.completed.associatedWaitpoint!)).toEqual(["id"]);

      expect(r.found).not.toBeNull();
      expect(r.found!.associatedWaitpoint).not.toBeNull();
      expect(r.found!.associatedWaitpoint!.id).toBe(r.waitpointId);
    }
  );

  heteroRunOpsPostgresTest(
    "completeAttemptSuccess + findRun honor associatedWaitpoint on the LEGACY client",
    async ({ prisma14 }) => {
      const r = await runAssociatedWaitpointScenario(prisma14, "legacy", "leg_aw");

      expect(r.completed.id).toBe(r.runId);
      expect(r.completed.associatedWaitpoint).not.toBeNull();
      expect(r.completed.associatedWaitpoint!.id).toBe(r.waitpointId);
      expect(r.found!.associatedWaitpoint!.id).toBe(r.waitpointId);
    }
  );

  // completedWaitpoints (snapshot group-A) — RED on dedicated before, GREEN after.
  heteroRunOpsPostgresTest(
    "findExecutionSnapshot honors completedWaitpoints on the DEDICATED client",
    async ({ prisma17 }) => {
      const r = await runCompletedWaitpointsScenario(prisma17, "dedicated", "ded_cw");

      expect(r.fetched).not.toBeNull();
      expect(r.fetched!.id).toBe(r.snapshotId);
      expect(r.fetched!.completedWaitpoints.map((w) => w.id).sort()).toEqual([r.w1, r.w2].sort());
    }
  );

  heteroRunOpsPostgresTest(
    "findExecutionSnapshot honors completedWaitpoints on the LEGACY client",
    async ({ prisma14 }) => {
      const r = await runCompletedWaitpointsScenario(prisma14, "legacy", "leg_cw");

      expect(r.fetched).not.toBeNull();
      expect(r.fetched!.completedWaitpoints.map((w) => w.id).sort()).toEqual([r.w1, r.w2].sort());
    }
  );

  // blockingTaskRuns connection back-ref (Waitpoint group-A) — RED on dedicated before, GREEN after.
  heteroRunOpsPostgresTest(
    "findWaitpoint honors blockingTaskRuns back-ref on the DEDICATED client",
    async ({ prisma17 }) => {
      const r = await runBlockingTaskRunsScenario(prisma17, "dedicated", "ded_bk");

      expect(r.waitpoint).not.toBeNull();
      expect(r.waitpoint!.id).toBe(r.waitpointId);
      const blocking = r.waitpoint!.blockingTaskRuns;
      expect(blocking.length).toBe(1);
      expect(blocking[0].taskRun.id).toBe(r.runId);
      expect(blocking[0].taskRun.friendlyId).toBe(r.friendlyId);
    }
  );

  heteroRunOpsPostgresTest(
    "findWaitpoint honors blockingTaskRuns back-ref on the LEGACY client",
    async ({ prisma14 }) => {
      const r = await runBlockingTaskRunsScenario(prisma14, "legacy", "leg_bk");

      expect(r.waitpoint).not.toBeNull();
      const blocking = r.waitpoint!.blockingTaskRuns;
      expect(blocking.length).toBe(1);
      expect(blocking[0].taskRun.id).toBe(r.runId);
      expect(blocking[0].taskRun.friendlyId).toBe(r.friendlyId);
    }
  );
});
