/**
 * Seeds the minimum a supervisor needs to exist against: a production
 * environment with a promoted managed deployment, and a worker group whose
 * token authenticates the `engine/v1/worker-actions/*` routes.
 *
 * Rows are written straight through prisma rather than through the deploy
 * services. The bench is measuring the worker-action request path, and going
 * through the real deploy flow would add a lot of setup surface without
 * changing a single byte of what those routes read.
 */
import { CURRENT_DEPLOYMENT_LABEL, generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { createHash, randomBytes } from "node:crypto";

const MANAGED_WORKER_SECRET = "test-managed-worker-secret-for-e2e-tests";

export type EngineFixtures = {
  organizationId: string;
  projectId: string;
  projectRef: string;
  environmentId: string;
  environmentApiKey: string;
  workerGroupId: string;
  workerGroupToken: string;
  masterQueue: string;
  taskIdentifiers: string[];
  deploymentId: string;
};

function randomHex(length = 12): string {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}

export async function seedEngineFixtures(
  prisma: PrismaClient,
  options: { taskCount?: number; concurrencyLimit?: number } = {}
): Promise<EngineFixtures> {
  const taskCount = options.taskCount ?? 4;
  const concurrencyLimit = options.concurrencyLimit ?? 500;
  const suffix = randomHex(8);

  const masterQueue = `bench-${suffix}`;
  const plaintextToken = `tr_wgt_${randomHex(40)}`;
  const tokenHash = createHash("sha256").update(plaintextToken).digest("hex");

  const organization = await prisma.organization.create({
    data: { title: `bench-org-${suffix}`, slug: `bench-org-${suffix}`, isActivated: true },
  });

  const workerGroup = await prisma.workerInstanceGroup.create({
    data: {
      name: `bench-group-${suffix}`,
      masterQueue,
      type: "MANAGED",
      token: { create: { tokenHash } },
    },
  });

  const project = await prisma.project.create({
    data: {
      name: `bench-project-${suffix}`,
      slug: `bench-proj-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
      engine: "V2",
      defaultWorkerGroupId: workerGroup.id,
    },
  });

  const environmentApiKey = `tr_prod_${randomHex(24)}`;

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      apiKey: environmentApiKey,
      pkApiKey: `pk_prod_${randomHex(24)}`,
      shortcode: suffix.slice(0, 6),
      projectId: project.id,
      organizationId: organization.id,
      maximumConcurrencyLimit: concurrencyLimit,
    },
  });

  const version = "20260101.1";

  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: generateFriendlyId("worker"),
      contentHash: `hash_${suffix}`,
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      version,
      metadata: {},
      engine: "V2",
    },
  });

  const taskIdentifiers = Array.from({ length: taskCount }, (_, i) => `bench-task-${i}`);

  for (const identifier of taskIdentifiers) {
    const task = await prisma.backgroundWorkerTask.create({
      data: {
        friendlyId: generateFriendlyId("task"),
        slug: identifier,
        filePath: `/trigger/${identifier}.ts`,
        exportName: identifier,
        workerId: worker.id,
        runtimeEnvironmentId: environment.id,
        projectId: project.id,
        retryConfig: {
          maxAttempts: 1,
          factor: 1,
          minTimeoutInMs: 100,
          maxTimeoutInMs: 100,
          randomize: false,
        },
      },
    });

    await prisma.taskQueue.upsert({
      where: {
        runtimeEnvironmentId_name: {
          name: `task/${identifier}`,
          runtimeEnvironmentId: environment.id,
        },
      },
      create: {
        friendlyId: generateFriendlyId("queue"),
        name: `task/${identifier}`,
        concurrencyLimit,
        runtimeEnvironmentId: environment.id,
        projectId: project.id,
        type: "VIRTUAL",
        workers: { connect: { id: worker.id } },
        tasks: { connect: { id: task.id } },
      },
      update: {
        concurrencyLimit,
        workers: { connect: { id: worker.id } },
        tasks: { connect: { id: task.id } },
      },
    });
  }

  const deployment = await prisma.workerDeployment.create({
    data: {
      friendlyId: generateFriendlyId("deployment"),
      contentHash: worker.contentHash,
      version,
      shortCode: `short_${suffix}`,
      imageReference: `bench/${project.externalRef}:${version}`,
      status: "DEPLOYED",
      projectId: project.id,
      environmentId: environment.id,
      workerId: worker.id,
      type: "MANAGED",
    },
  });

  await prisma.workerDeploymentPromotion.upsert({
    where: {
      environmentId_label: { environmentId: environment.id, label: CURRENT_DEPLOYMENT_LABEL },
    },
    create: {
      deploymentId: deployment.id,
      environmentId: environment.id,
      label: CURRENT_DEPLOYMENT_LABEL,
    },
    update: { deploymentId: deployment.id },
  });

  return {
    organizationId: organization.id,
    projectId: project.id,
    projectRef: project.externalRef,
    environmentId: environment.id,
    environmentApiKey,
    workerGroupId: workerGroup.id,
    workerGroupToken: plaintextToken,
    masterQueue,
    taskIdentifiers,
    deploymentId: deployment.id,
  };
}

/**
 * Headers a managed supervisor sends on every worker-action request.
 */
export function workerHeaders(fixtures: EngineFixtures, instanceName: string): HeadersInit {
  return {
    Authorization: `Bearer ${fixtures.workerGroupToken}`,
    "x-trigger-worker-instance-name": instanceName,
    "x-trigger-worker-managed-secret": MANAGED_WORKER_SECRET,
    "content-type": "application/json",
  };
}
