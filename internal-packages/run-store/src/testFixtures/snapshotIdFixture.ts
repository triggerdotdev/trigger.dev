// Shared setup for the snapshot-id, snapshot-writes and entry-parity suites. Modelled on the
// seedEnvironment/buildCreateRunInput pair in PostgresRunStore.test.ts; the slugs are suffixed so
// several fixtures can coexist in one database.
import type { PrismaClient, TaskRunStatus } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import type { CreateRunData } from "../types.js";

export type SnapshotFixtureEnv = {
  id: string;
  type: "DEVELOPMENT";
  projectId: string;
  organizationId: string;
};

export type SnapshotIdFixture = {
  run: { id: string };
  env: SnapshotFixtureEnv;
};

export async function seedSnapshotEnvironment(prisma: PrismaClient): Promise<SnapshotFixtureEnv> {
  const suffix = generateInternalId().slice(-12);

  const organization = await prisma.organization.create({
    data: { title: `Snapshot Org ${suffix}`, slug: `snapshot-org-${suffix}` },
  });

  const project = await prisma.project.create({
    data: {
      name: `Snapshot Project ${suffix}`,
      slug: `snapshot-project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: `dev-${suffix}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });

  return {
    id: environment.id,
    type: "DEVELOPMENT",
    projectId: project.id,
    organizationId: organization.id,
  };
}

export function buildCreateRunData(runId: string, env: SnapshotFixtureEnv): CreateRunData {
  return {
    id: runId,
    engine: "V2",
    status: "PENDING",
    friendlyId: `run_${runId.slice(-16)}`,
    runtimeEnvironmentId: env.id,
    environmentType: env.type,
    organizationId: env.organizationId,
    projectId: env.projectId,
    taskIdentifier: "my-task",
    payload: "{}",
    payloadType: "application/json",
    traceContext: {},
    traceId: `trace_${runId.slice(-8)}`,
    spanId: `span_${runId.slice(-8)}`,
    queue: "task/my-task",
    isTest: false,
    taskEventStore: "taskEvent",
    depth: 0,
  };
}

export type SnapshotWorkerFixture = { workerId: string; taskId: string };

/**
 * Seeds a BackgroundWorker and one of its tasks. The snapshot's `workerId` and the run's
 * `lockedById` are both foreign keys, so a made-up id fails the constraint rather than the
 * assertion, and the test reports a fixture fault as if it were a parity fault.
 */
export async function seedSnapshotWorker(
  prisma: PrismaClient,
  env: SnapshotFixtureEnv
): Promise<SnapshotWorkerFixture> {
  const suffix = generateInternalId().slice(-12);

  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${suffix}`,
      engine: "V2",
      contentHash: `hash_${suffix}`,
      projectId: env.projectId,
      runtimeEnvironmentId: env.id,
      version: "20260824.1",
      metadata: {},
    },
  });

  const task = await prisma.backgroundWorkerTask.create({
    data: {
      slug: "my-task",
      friendlyId: `task_${suffix}`,
      filePath: "src/trigger/my-task.ts",
      exportName: "myTask",
      workerId: worker.id,
      projectId: env.projectId,
      runtimeEnvironmentId: env.id,
    },
  });

  return { workerId: worker.id, taskId: task.id };
}

/**
 * Seeds an environment plus one run in `status`, with no execution snapshot. The suites that use it
 * assert on the snapshot rows a store method writes, so the run must start with none.
 */
export async function setupSnapshotIdFixture(
  prisma: PrismaClient,
  opts?: { status?: TaskRunStatus }
): Promise<SnapshotIdFixture> {
  const env = await seedSnapshotEnvironment(prisma);
  const runId = generateInternalId();

  await prisma.taskRun.create({
    data: { ...buildCreateRunData(runId, env), status: opts?.status ?? "PENDING" },
  });

  return { run: { id: runId }, env };
}
