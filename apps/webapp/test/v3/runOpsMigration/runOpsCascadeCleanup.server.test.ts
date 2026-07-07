import { heteroPostgresTest, heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect, vi } from "vitest";
import { RunOpsCascadeCleanupService } from "~/v3/runOpsMigration/runOpsCascadeCleanup.server";

// Cross-DB testcontainer spin-up + the multi-table seed can exceed the 5s default.
vi.setConfig({ testTimeout: 120_000 });

// Run-subgraph tables that live in BOTH the control-plane schema AND the dedicated run-ops SUBSET
// schema, so they are deleted on every run-ops writer.
const SUBGRAPH_TABLES = [
  "taskRun",
  "taskRunAttempt",
  "waitpoint",
  "taskRunWaitpoint",
  "taskRunCheckpoint",
  "checkpoint",
  "checkpointRestoreEvent",
  "batchTaskRun",
] as const;

type SubgraphTable = (typeof SUBGRAPH_TABLES)[number];

let seedCounter = 0;

/**
 * The cross-seam (run-ops -> control-plane) Cascade FKs that the cloud DB physically drops. Applied
 * to the FK-dropped fixture to model cloud; the other side keeps them to model self-host. Only the
 * run-subgraph constraints exist on the dedicated run-ops schema; BulkActionItem's are control-plane
 * only and are dropped separately on a full-schema client.
 */
const SUBGRAPH_CROSS_SEAM_FKS: Array<{ table: string; constraint: string }> = [
  { table: "TaskRun", constraint: "TaskRun_runtimeEnvironmentId_fkey" },
  { table: "TaskRun", constraint: "TaskRun_projectId_fkey" },
  { table: "TaskRunAttempt", constraint: "TaskRunAttempt_runtimeEnvironmentId_fkey" },
  { table: "Waitpoint", constraint: "Waitpoint_environmentId_fkey" },
  { table: "Waitpoint", constraint: "Waitpoint_projectId_fkey" },
  { table: "TaskRunWaitpoint", constraint: "TaskRunWaitpoint_projectId_fkey" },
  { table: "TaskRunCheckpoint", constraint: "TaskRunCheckpoint_runtimeEnvironmentId_fkey" },
  { table: "TaskRunCheckpoint", constraint: "TaskRunCheckpoint_projectId_fkey" },
  { table: "Checkpoint", constraint: "Checkpoint_runtimeEnvironmentId_fkey" },
  { table: "Checkpoint", constraint: "Checkpoint_projectId_fkey" },
  {
    table: "CheckpointRestoreEvent",
    constraint: "CheckpointRestoreEvent_runtimeEnvironmentId_fkey",
  },
  { table: "CheckpointRestoreEvent", constraint: "CheckpointRestoreEvent_projectId_fkey" },
  { table: "BatchTaskRun", constraint: "BatchTaskRun_runtimeEnvironmentId_fkey" },
];

const BULK_ACTION_CROSS_SEAM_FKS: Array<{ table: string; constraint: string }> = [
  { table: "BulkActionItem", constraint: "BulkActionItem_sourceRunId_fkey" },
  { table: "BulkActionItem", constraint: "BulkActionItem_destinationRunId_fkey" },
];

async function dropCrossSeamFks(
  prisma: { $executeRawUnsafe: (q: string) => Promise<unknown> },
  fks: Array<{ table: string; constraint: string }>
) {
  for (const { table, constraint } of fks) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`
    );
  }
}

type Scope = { projectId: string; environmentId: string; organizationId: string };
type FullScope = Scope & { workerTaskId: string; queueId: string; backgroundWorkerId: string };

// Minimal structural client covering the control-plane prerequisites + run-subgraph models the
// seed/count helpers touch. Both PrismaClient and RunOpsPrismaClient are assignable.
type SeedClient = {
  organization: any;
  project: any;
  runtimeEnvironment: any;
  backgroundWorker: any;
  backgroundWorkerTask: any;
  taskQueue: any;
  taskRun: any;
  taskRunAttempt: any;
  waitpoint: any;
  taskRunWaitpoint: any;
  taskRunCheckpoint: any;
  checkpoint: any;
  checkpointRestoreEvent: any;
  batchTaskRun: any;
};

// Synthetic scope for the dedicated run-ops subset client, whose schema scalarizes every
// control-plane FK so no org/project/env rows are required.
function makeSyntheticScope(): FullScope {
  const n = seedCounter++;
  return {
    projectId: `proj_synthetic_${n}`,
    environmentId: `env_synthetic_${n}`,
    organizationId: `org_synthetic_${n}`,
    workerTaskId: `task_synthetic_${n}`,
    queueId: `queue_synthetic_${n}`,
    backgroundWorkerId: `worker_synthetic_${n}`,
  };
}

/** Create the control-plane prerequisites (org, project, env, worker, task, queue). */
async function seedScope(prisma: SeedClient): Promise<FullScope> {
  const n = seedCounter++;
  const org = await prisma.organization.create({
    data: { title: `Org ${n}`, slug: `org-${n}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${n}`,
      slug: `project-${n}`,
      externalRef: `proj_${n}`,
      organizationId: org.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `env-${n}`,
      projectId: project.id,
      organizationId: org.id,
      apiKey: `tr_prod_${n}`,
      pkApiKey: `pk_prod_${n}`,
      shortcode: `short_${n}`,
    },
  });
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${n}`,
      contentHash: `hash_${n}`,
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      version: `2024.1.${n}`,
      metadata: {},
      engine: "V2",
    },
  });
  const task = await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${n}`,
      slug: `my-task-${n}`,
      filePath: "index.ts",
      exportName: "myTask",
      workerId: worker.id,
      runtimeEnvironmentId: environment.id,
      projectId: project.id,
    },
  });
  const queue = await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${n}`,
      name: `task/my-task-${n}`,
      runtimeEnvironmentId: environment.id,
      projectId: project.id,
    },
  });
  return {
    projectId: project.id,
    environmentId: environment.id,
    organizationId: org.id,
    workerTaskId: task.id,
    queueId: queue.id,
    backgroundWorkerId: worker.id,
  };
}

/**
 * Seed one full run-ops subgraph for a scope: a TaskRun tree (root + child), an attempt, a
 * Waitpoint with a blocking edge (TaskRunWaitpoint), a TaskRunCheckpoint, a Checkpoint + a
 * CheckpointRestoreEvent, and a BatchTaskRun with a member run. Returns the source + destination
 * runs so a caller with a control-plane client can attach a BulkActionItem.
 */
async function seedRunOpsSubgraph(
  prisma: SeedClient,
  scope: Scope & { backgroundWorkerId: string; workerTaskId: string; queueId: string }
): Promise<{ sourceRunId: string; destinationRunId: string }> {
  const n = seedCounter++;
  const { projectId, environmentId } = scope;

  const baseRun = (suffix: string) => ({
    friendlyId: `run_${n}_${suffix}`,
    taskIdentifier: `my-task-${n}`,
    payload: "{}",
    payloadType: "application/json",
    traceId: `trace_${n}_${suffix}`,
    spanId: `span_${n}_${suffix}`,
    queue: `task/my-task-${n}`,
    runtimeEnvironmentId: environmentId,
    projectId,
  });

  const rootRun = await prisma.taskRun.create({ data: baseRun("root") });
  const childRun = await prisma.taskRun.create({
    data: { ...baseRun("child"), parentTaskRunId: rootRun.id, rootTaskRunId: rootRun.id },
  });

  const attempt = await prisma.taskRunAttempt.create({
    data: {
      friendlyId: `attempt_${n}`,
      taskRunId: rootRun.id,
      backgroundWorkerId: scope.backgroundWorkerId,
      backgroundWorkerTaskId: scope.workerTaskId,
      runtimeEnvironmentId: environmentId,
      queueId: scope.queueId,
    },
  });

  const waitpoint = await prisma.waitpoint.create({
    data: {
      friendlyId: `wp_${n}`,
      type: "MANUAL",
      idempotencyKey: `wp_idem_${n}`,
      userProvidedIdempotencyKey: false,
      environmentId,
      projectId,
    },
  });
  await prisma.taskRunWaitpoint.create({
    data: { taskRunId: rootRun.id, waitpointId: waitpoint.id, projectId },
  });

  await prisma.taskRunCheckpoint.create({
    data: {
      friendlyId: `trcp_${n}`,
      type: "DOCKER",
      location: "loc",
      runtimeEnvironmentId: environmentId,
      projectId,
    },
  });

  const checkpoint = await prisma.checkpoint.create({
    data: {
      friendlyId: `cp_${n}`,
      type: "DOCKER",
      location: "loc",
      imageRef: "ref",
      runId: rootRun.id,
      attemptId: attempt.id,
      runtimeEnvironmentId: environmentId,
      projectId,
    },
  });
  await prisma.checkpointRestoreEvent.create({
    data: {
      type: "CHECKPOINT",
      checkpointId: checkpoint.id,
      runId: rootRun.id,
      attemptId: attempt.id,
      runtimeEnvironmentId: environmentId,
      projectId,
    },
  });

  const batch = await prisma.batchTaskRun.create({
    data: { friendlyId: `batch_${n}`, runtimeEnvironmentId: environmentId },
  });
  await prisma.taskRun.update({ where: { id: childRun.id }, data: { batchId: batch.id } });

  const sourceRun = await prisma.taskRun.create({ data: baseRun("src") });
  const destRun = await prisma.taskRun.create({ data: baseRun("dst") });
  return { sourceRunId: sourceRun.id, destinationRunId: destRun.id };
}

/** Attach a BulkActionItem (control-plane-resident) over the given source/destination runs. */
async function seedBulkActionItem(
  prisma: PrismaClient,
  runs: { sourceRunId: string; destinationRunId: string }
): Promise<void> {
  await prisma.bulkActionItem.create({
    data: {
      groupId: `grp_${seedCounter++}`,
      type: "REPLAY",
      sourceRunId: runs.sourceRunId,
      destinationRunId: runs.destinationRunId,
    },
  });
}

async function subgraphCountsForScope(
  prisma: SeedClient,
  scope: { projectId: string }
): Promise<Record<SubgraphTable, number>> {
  const { projectId } = scope;
  return {
    taskRun: await prisma.taskRun.count({ where: { projectId } }),
    taskRunAttempt: await prisma.taskRunAttempt.count({ where: { taskRun: { projectId } } }),
    waitpoint: await prisma.waitpoint.count({ where: { projectId } }),
    taskRunWaitpoint: await prisma.taskRunWaitpoint.count({ where: { projectId } }),
    taskRunCheckpoint: await prisma.taskRunCheckpoint.count({ where: { projectId } }),
    checkpoint: await prisma.checkpoint.count({ where: { projectId } }),
    checkpointRestoreEvent: await prisma.checkpointRestoreEvent.count({ where: { projectId } }),
    batchTaskRun: await prisma.batchTaskRun.count({
      where: { runs: { some: { projectId } } },
    }),
  };
}

async function bulkActionItemCountForScope(
  prisma: PrismaClient,
  scope: { projectId: string }
): Promise<number> {
  return prisma.bulkActionItem.count({ where: { sourceRun: { projectId: scope.projectId } } });
}

function expectSubgraphAllZero(counts: Record<SubgraphTable, number>) {
  for (const table of SUBGRAPH_TABLES) {
    expect(counts[table], `${table} should be empty`).toBe(0);
  }
}

function expectSubgraphAllNonZero(counts: Record<SubgraphTable, number>) {
  for (const table of SUBGRAPH_TABLES) {
    expect(counts[table], `${table} should be seeded`).toBeGreaterThan(0);
  }
}

describe("RunOpsCascadeCleanupService", () => {
  // REGRESSION: the NEW run-ops writer is a real RunOpsPrismaClient over the dedicated
  // SUBSET schema — it has NO `bulkActionItem` delegate. Before the fix, the per-writer pass called
  // `writer.bulkActionItem.deleteMany` on this client => TypeError (Cannot read properties of
  // undefined). After the fix, BulkActionItem is cleaned ONLY on the control-plane writer (prisma14),
  // and the run-subgraph is deleted on the NEW DB without throwing.
  heteroRunOpsPostgresTest(
    "cleanupProject does not throw on the dedicated RunOpsPrismaClient and clears the new DB subgraph",
    async ({ prisma14, prisma17 }) => {
      await dropCrossSeamFks(prisma14, BULK_ACTION_CROSS_SEAM_FKS);

      // The dedicated run-ops subset schema scalarizes every control-plane FK, so the NEW DB needs
      // NO org/project/env prereqs — seed the subgraph directly with synthetic scope ids.
      const newScope = makeSyntheticScope();
      await seedRunOpsSubgraph(prisma17 as unknown as SeedClient, newScope);

      // BulkActionItem (control-plane-resident) lives only on the control-plane DB.
      const cp = await seedScope(prisma14);
      const cpRuns = await seedRunOpsSubgraph(prisma14, cp);
      await seedBulkActionItem(prisma14, cpRuns);

      // prisma17 is a real RunOpsPrismaClient (subset, no bulkActionItem delegate); prisma14 is the
      // control-plane writer. Before the fix this threw a TypeError on writer.bulkActionItem.
      const result = await new RunOpsCascadeCleanupService({
        runOpsWriters: [prisma17, prisma14 as unknown as RunOpsPrismaClient],
        controlPlaneWriter: prisma14,
      }).cleanupProject(newScope.projectId);

      expectSubgraphAllZero(
        await subgraphCountsForScope(prisma17 as unknown as SeedClient, newScope)
      );
      // BulkActionItem cleanup ran against the control-plane writer and deleted the control-plane
      // project's item; the subset client was never asked for the missing delegate.
      expect(result.bulkActionItem).toBeGreaterThanOrEqual(0);
    }
  );

  // REGRESSION (env variant): same guarantee for cleanupEnvironment.
  heteroRunOpsPostgresTest(
    "cleanupEnvironment does not throw on the dedicated RunOpsPrismaClient and clears the new DB subgraph",
    async ({ prisma14, prisma17 }) => {
      await dropCrossSeamFks(prisma14, BULK_ACTION_CROSS_SEAM_FKS);

      const newScope = makeSyntheticScope();
      await seedRunOpsSubgraph(prisma17 as unknown as SeedClient, newScope);

      const cp = await seedScope(prisma14);
      const cpRuns = await seedRunOpsSubgraph(prisma14, cp);
      await seedBulkActionItem(prisma14, cpRuns);

      const result = await new RunOpsCascadeCleanupService({
        runOpsWriters: [prisma17, prisma14 as unknown as RunOpsPrismaClient],
        controlPlaneWriter: prisma14,
      }).cleanupEnvironment(newScope.environmentId);

      expectSubgraphAllZero(
        await subgraphCountsForScope(prisma17 as unknown as SeedClient, newScope)
      );
      expect(result.bulkActionItem).toBeGreaterThanOrEqual(0);
    }
  );

  // Env cleanup over both writers empties the subgraph on BOTH DBs + BulkActionItem on the
  // control-plane DB; a sibling scope survives.
  heteroPostgresTest(
    "cleanupEnvironment empties the subgraph across both writers, isolating a sibling env",
    async ({ prisma14, prisma17 }) => {
      await dropCrossSeamFks(prisma17, SUBGRAPH_CROSS_SEAM_FKS);
      await dropCrossSeamFks(prisma17, BULK_ACTION_CROSS_SEAM_FKS);

      const target14 = await seedScope(prisma14);
      const target17 = await seedScope(prisma17);
      const targetRuns14 = await seedRunOpsSubgraph(prisma14, target14);
      await seedRunOpsSubgraph(prisma17, target17);
      await seedBulkActionItem(prisma14, targetRuns14);

      const sibling14 = await seedScope(prisma14);
      const sibling17 = await seedScope(prisma17);
      const siblingRuns14 = await seedRunOpsSubgraph(prisma14, sibling14);
      await seedRunOpsSubgraph(prisma17, sibling17);
      await seedBulkActionItem(prisma14, siblingRuns14);

      await new RunOpsCascadeCleanupService({
        runOpsWriters: [prisma17, prisma14],
        controlPlaneWriter: prisma14,
      }).cleanupEnvironment(target14.environmentId);
      await new RunOpsCascadeCleanupService({
        runOpsWriters: [prisma17, prisma14],
        controlPlaneWriter: prisma14,
      }).cleanupEnvironment(target17.environmentId);

      expectSubgraphAllZero(await subgraphCountsForScope(prisma14, target14));
      expectSubgraphAllZero(await subgraphCountsForScope(prisma17, target17));
      expect(await bulkActionItemCountForScope(prisma14, target14)).toBe(0);
      expectSubgraphAllNonZero(await subgraphCountsForScope(prisma14, sibling14));
      expectSubgraphAllNonZero(await subgraphCountsForScope(prisma17, sibling17));
      expect(await bulkActionItemCountForScope(prisma14, sibling14)).toBeGreaterThan(0);
    }
  );

  // Project cleanup over both writers.
  heteroPostgresTest(
    "cleanupProject empties the subgraph across both writers, isolating a sibling project",
    async ({ prisma14, prisma17 }) => {
      await dropCrossSeamFks(prisma17, SUBGRAPH_CROSS_SEAM_FKS);
      await dropCrossSeamFks(prisma17, BULK_ACTION_CROSS_SEAM_FKS);

      const target14 = await seedScope(prisma14);
      const target17 = await seedScope(prisma17);
      const targetRuns14 = await seedRunOpsSubgraph(prisma14, target14);
      await seedRunOpsSubgraph(prisma17, target17);
      await seedBulkActionItem(prisma14, targetRuns14);

      const sibling14 = await seedScope(prisma14);
      const sibling17 = await seedScope(prisma17);
      const siblingRuns14 = await seedRunOpsSubgraph(prisma14, sibling14);
      await seedRunOpsSubgraph(prisma17, sibling17);
      await seedBulkActionItem(prisma14, siblingRuns14);

      await new RunOpsCascadeCleanupService({
        runOpsWriters: [prisma17, prisma14],
        controlPlaneWriter: prisma14,
      }).cleanupProject(target14.projectId);
      await new RunOpsCascadeCleanupService({
        runOpsWriters: [prisma17, prisma14],
        controlPlaneWriter: prisma14,
      }).cleanupProject(target17.projectId);

      expectSubgraphAllZero(await subgraphCountsForScope(prisma14, target14));
      expectSubgraphAllZero(await subgraphCountsForScope(prisma17, target17));
      expect(await bulkActionItemCountForScope(prisma14, target14)).toBe(0);
      expectSubgraphAllNonZero(await subgraphCountsForScope(prisma14, sibling14));
      expectSubgraphAllNonZero(await subgraphCountsForScope(prisma17, sibling17));
      expect(await bulkActionItemCountForScope(prisma14, sibling14)).toBeGreaterThan(0);
    }
  );

  // Idempotency — a second cleanup returns all-zero counts and does not throw on either DB.
  heteroPostgresTest(
    "cleanupEnvironment is idempotent on a re-run across both FK configs",
    async ({ prisma14, prisma17 }) => {
      await dropCrossSeamFks(prisma17, SUBGRAPH_CROSS_SEAM_FKS);
      await dropCrossSeamFks(prisma17, BULK_ACTION_CROSS_SEAM_FKS);

      const t14 = await seedScope(prisma14);
      const t17 = await seedScope(prisma17);
      const runs14 = await seedRunOpsSubgraph(prisma14, t14);
      await seedRunOpsSubgraph(prisma17, t17);
      await seedBulkActionItem(prisma14, runs14);

      const svc14 = new RunOpsCascadeCleanupService({
        runOpsWriters: [prisma14],
        controlPlaneWriter: prisma14,
      });
      const svc17 = new RunOpsCascadeCleanupService({
        runOpsWriters: [prisma17],
        controlPlaneWriter: prisma14,
      });
      await svc14.cleanupEnvironment(t14.environmentId);
      await svc17.cleanupEnvironment(t17.environmentId);

      const second14 = await svc14.cleanupEnvironment(t14.environmentId);
      const second17 = await svc17.cleanupEnvironment(t17.environmentId);

      for (const result of [second14, second17]) {
        for (const count of Object.values(result)) {
          expect(count).toBe(0);
        }
      }
      expectSubgraphAllZero(await subgraphCountsForScope(prisma14, t14));
      expectSubgraphAllZero(await subgraphCountsForScope(prisma17, t17));
    }
  );

  // FK-retained vs FK-dropped fixtures reach an identical run-subgraph end-state.
  heteroPostgresTest(
    "FK-retained and FK-dropped fixtures reach an identical end-state after cleanup",
    async ({ prisma14, prisma17 }) => {
      await dropCrossSeamFks(prisma17, SUBGRAPH_CROSS_SEAM_FKS);

      const s14 = await seedScope(prisma14);
      const s17 = await seedScope(prisma17);
      await seedRunOpsSubgraph(prisma14, s14);
      await seedRunOpsSubgraph(prisma17, s17);

      await new RunOpsCascadeCleanupService({
        runOpsWriters: [prisma14],
        controlPlaneWriter: prisma14,
      }).cleanupEnvironment(s14.environmentId);
      await new RunOpsCascadeCleanupService({
        runOpsWriters: [prisma17],
        controlPlaneWriter: prisma17,
      }).cleanupEnvironment(s17.environmentId);

      const counts14 = await subgraphCountsForScope(prisma14, s14);
      const counts17 = await subgraphCountsForScope(prisma17, s17);
      expect(counts17).toEqual(counts14);
    }
  );

  // Single-DB mode — the same client passed twice de-dups so the pass runs once.
  heteroPostgresTest(
    "single-DB: the same client passed twice de-dups so the delete pass runs exactly once",
    async ({ prisma14 }) => {
      const scope = await seedScope(prisma14);
      await seedRunOpsSubgraph(prisma14, scope);

      const before = await subgraphCountsForScope(prisma14, scope);

      // Wrap the real client with a $extends query hook that counts deleteMany calls per model. NOT
      // a mock — the query still runs against the container. If de-dup failed, the loop would run
      // twice against this same client and taskRun.deleteMany would fire twice.
      let taskRunDeleteManyCalls = 0;
      const counting = prisma14.$extends({
        query: {
          taskRun: {
            async deleteMany({ args, query }) {
              taskRunDeleteManyCalls++;
              return query(args);
            },
          },
        },
      }) as unknown as typeof prisma14;

      const result = await new RunOpsCascadeCleanupService({
        runOpsWriters: [counting, counting],
        controlPlaneWriter: counting,
      }).cleanupEnvironment(scope.environmentId);

      // De-dup ran the pass exactly once: one taskRun.deleteMany, count not double-summed.
      expect(taskRunDeleteManyCalls).toBe(1);
      expect(result.taskRun).toBe(before.taskRun);
      expectSubgraphAllZero(await subgraphCountsForScope(prisma14, scope));
    }
  );

  // The two-writer split — an env whose rows straddle both DBs (cuid runs on the LEGACY DB,
  // run-ops runs on the NEW DB) is fully cleaned by one call; a single-writer service leaks orphans.
  heteroPostgresTest(
    "two-writer fan-out cleans a split env on both DBs; single-writer leaves orphans",
    async ({ prisma14, prisma17 }) => {
      await dropCrossSeamFks(prisma17, SUBGRAPH_CROSS_SEAM_FKS);

      // One logical env that exists on both DBs (control-plane prereqs seeded on each), with the
      // SAME env id, modelling the reference-equal control-plane row. We force a shared id
      // by creating the legacy scope first, then mirroring its env id onto the new DB.
      const legacy = await seedScope(prisma14);
      const newOrg = await prisma17.organization.create({
        data: { id: legacy.organizationId, title: "mirror", slug: `mirror-${seedCounter++}` },
      });
      const newProject = await prisma17.project.create({
        data: {
          id: legacy.projectId,
          name: "mirror",
          slug: `mirror-${seedCounter++}`,
          externalRef: `mirror_${seedCounter++}`,
          organizationId: newOrg.id,
        },
      });
      const newEnv = await prisma17.runtimeEnvironment.create({
        data: {
          id: legacy.environmentId,
          type: "PRODUCTION",
          slug: `mirror-${seedCounter++}`,
          projectId: newProject.id,
          organizationId: newOrg.id,
          apiKey: `tr_${seedCounter++}`,
          pkApiKey: `pk_${seedCounter++}`,
          shortcode: `sc_${seedCounter++}`,
        },
      });
      const newWorker = await prisma17.backgroundWorker.create({
        data: {
          friendlyId: `w_${seedCounter++}`,
          contentHash: "h",
          projectId: newProject.id,
          runtimeEnvironmentId: newEnv.id,
          version: `2024.2.${seedCounter++}`,
          metadata: {},
          engine: "V2",
        },
      });
      const newTask = await prisma17.backgroundWorkerTask.create({
        data: {
          friendlyId: `t_${seedCounter++}`,
          slug: `s-${seedCounter++}`,
          filePath: "index.ts",
          exportName: "myTask",
          workerId: newWorker.id,
          runtimeEnvironmentId: newEnv.id,
          projectId: newProject.id,
        },
      });
      const newQueue = await prisma17.taskQueue.create({
        data: {
          friendlyId: `q_${seedCounter++}`,
          name: `task/s-${seedCounter++}`,
          runtimeEnvironmentId: newEnv.id,
          projectId: newProject.id,
        },
      });

      const newScope = {
        projectId: newProject.id,
        environmentId: newEnv.id,
        organizationId: newOrg.id,
        backgroundWorkerId: newWorker.id,
        workerTaskId: newTask.id,
        queueId: newQueue.id,
      };

      // Pre-cutover (LEGACY DB) and post-cutover (NEW DB) run-ops rows for the SAME env.
      await seedRunOpsSubgraph(prisma14, legacy);
      await seedRunOpsSubgraph(prisma17, newScope);

      // Two-writer fan-out: one call cleans BOTH DBs.
      await new RunOpsCascadeCleanupService({
        runOpsWriters: [prisma17, prisma14],
        controlPlaneWriter: prisma14,
      }).cleanupEnvironment(legacy.environmentId);

      expectSubgraphAllZero(await subgraphCountsForScope(prisma14, legacy));
      expectSubgraphAllZero(await subgraphCountsForScope(prisma17, newScope));

      // The orphan-leak guard: re-seed and run a mis-built SINGLE-writer service; it must leave the
      // OTHER DB's rows behind.
      await seedRunOpsSubgraph(prisma14, legacy);
      await seedRunOpsSubgraph(prisma17, newScope);

      await new RunOpsCascadeCleanupService({
        runOpsWriters: [prisma17],
        controlPlaneWriter: prisma14,
      }).cleanupEnvironment(legacy.environmentId);

      // NEW DB cleaned, LEGACY DB orphans remain — proving a one-handle delete leaks.
      expectSubgraphAllZero(await subgraphCountsForScope(prisma17, newScope));
      const leaked = await subgraphCountsForScope(prisma14, legacy);
      expect(leaked.taskRun).toBeGreaterThan(0);
    }
  );
});
