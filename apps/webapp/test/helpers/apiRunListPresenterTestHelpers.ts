import type { ClickHouse, TaskRunV2 } from "@internal/clickhouse";
import type { PrismaClient, TaskRun, TaskRunStatus } from "@trigger.dev/database";
import { z } from "zod";

export type SeedContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  environmentSlug: string;
};

/** Creates the org/project/environment parents needed by TaskRun foreign keys. */
export async function seedParents(
  prisma: PrismaClient,
  slug: string,
  envSlug = `env-${slug}`
): Promise<SeedContext> {
  const organization = await prisma.organization.create({
    data: { title: `org-${slug}`, slug: `org-${slug}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: organization.id,
      externalRef: `proj-${slug}`,
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: envSlug,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slug}`,
      pkApiKey: `pk_dev_${slug}`,
      shortcode: `sc-${slug}`,
    },
  });

  return {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: runtimeEnvironment.id,
    environmentSlug: runtimeEnvironment.slug,
  };
}

/** Adds another control-plane environment to an existing project. */
export async function addEnvironment(
  prisma: PrismaClient,
  ctx: SeedContext,
  slug: string,
  envSlug: string
): Promise<string> {
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: envSlug,
      type: "STAGING",
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      apiKey: `tr_${envSlug}_${slug}`,
      pkApiKey: `pk_${envSlug}_${slug}`,
      shortcode: `sc-${envSlug}-${slug}`,
    },
  });

  return environment.id;
}

/** Mirrors the parents onto another database with the same IDs. */
export async function mirrorParents(
  prisma: PrismaClient,
  ctx: SeedContext,
  slug: string
): Promise<void> {
  await prisma.organization.create({
    data: { id: ctx.organizationId, title: `org-${slug}`, slug: `org-${slug}` },
  });
  await prisma.project.create({
    data: {
      id: ctx.projectId,
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: ctx.organizationId,
      externalRef: `proj-${slug}`,
    },
  });
  await prisma.runtimeEnvironment.create({
    data: {
      id: ctx.environmentId,
      slug: ctx.environmentSlug,
      type: "DEVELOPMENT",
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      apiKey: `tr_dev_${slug}_b`,
      pkApiKey: `pk_dev_${slug}_b`,
      shortcode: `sc-${slug}-b`,
    },
  });
}

export async function createRun(
  prisma: PrismaClient,
  ctx: SeedContext,
  run: {
    friendlyId: string;
    taskIdentifier?: string;
    status?: TaskRunStatus;
    runtimeEnvironmentId?: string;
  }
): Promise<TaskRun> {
  return prisma.taskRun.create({
    data: {
      friendlyId: run.friendlyId,
      taskIdentifier: run.taskIdentifier ?? "my-task",
      status: run.status ?? "PENDING",
      payload: JSON.stringify({ foo: run.friendlyId }),
      traceId: run.friendlyId,
      spanId: run.friendlyId,
      queue: "test",
      runTags: [],
      runtimeEnvironmentId: run.runtimeEnvironmentId ?? ctx.environmentId,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
    },
  });
}

/** Inserts the ClickHouse list-index rows synchronously, without logical replication. */
export async function insertTaskRunV2Rows(clickhouse: ClickHouse, runs: TaskRun[]): Promise<void> {
  const insert = clickhouse.writer.insert({
    name: "insertApiRunListPresenterTaskRuns",
    table: "trigger_dev.task_runs_v2",
    schema: z.any(),
    settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
  });

  const rows: TaskRunV2[] = runs.map((run) => ({
    environment_id: run.runtimeEnvironmentId,
    organization_id: run.organizationId ?? "",
    project_id: run.projectId,
    run_id: run.id,
    friendly_id: run.friendlyId,
    updated_at: run.updatedAt.getTime(),
    created_at: run.createdAt.getTime(),
    status: run.status,
    environment_type: run.environmentType ?? "DEVELOPMENT",
    attempt: run.attemptNumber ?? 1,
    engine: run.engine,
    task_identifier: run.taskIdentifier,
    queue: run.queue,
    schedule_id: "",
    batch_id: "",
    task_version: run.taskVersion ?? "",
    sdk_version: run.sdkVersion ?? "",
    cli_version: run.cliVersion ?? "",
    output: null,
    error: null,
    machine_preset: run.machinePreset ?? "",
    root_run_id: "",
    parent_run_id: "",
    span_id: run.spanId,
    trace_id: run.traceId,
    idempotency_key: run.idempotencyKey ?? "",
    expiration_ttl: run.ttl ?? "",
    tags: run.runTags,
    worker_queue: run.workerQueue,
    region: run.region ?? "",
    _version: String(run.updatedAt.getTime()),
    _is_deleted: 0,
  }));

  const [error] = await insert(rows);
  if (error) {
    throw error;
  }
}
