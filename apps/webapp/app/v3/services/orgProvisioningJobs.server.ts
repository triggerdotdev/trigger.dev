import { tryCatch } from "@trigger.dev/core/v3";
import { Prisma, type Organization, type Project } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { createEnvironment } from "~/models/organization.server";
import { createRedisClient } from "~/redis.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { updateEnvConcurrencyLimits } from "~/v3/runQueue.server";
import { concurrencySystem } from "./concurrencySystemInstance.server";
import {
  convergeOrgRunsEnabled,
  provisionOrgStagingEnvironments,
  pushOrgConcurrencyLimits,
  reconcilingPush,
} from "./orgPlanProvisioning.server";
import { createOrgProvisioningLock } from "./orgProvisioningLock.server";

export const ORG_PROVISIONING_VISIBILITY_TIMEOUT_MS = 5 * 60_000;

export const OrgProvisioningPayloadSchema = z.object({ organizationId: z.string() });

export type OrgProvisioningJob =
  | "org.convergeRunsEnabled"
  | "org.pushConcurrencyLimits"
  | "org.provisionStagingEnvironments";

const withLock = singleton("orgProvisioningLock", () =>
  createOrgProvisioningLock(
    createRedisClient("trigger:org-provisioning-lock", {
      host: env.COMMON_WORKER_REDIS_HOST,
      port: env.COMMON_WORKER_REDIS_PORT,
      username: env.COMMON_WORKER_REDIS_USERNAME,
      password: env.COMMON_WORKER_REDIS_PASSWORD,
      tlsDisabled: env.COMMON_WORKER_REDIS_TLS_DISABLED === "true",
      clusterMode: env.COMMON_WORKER_REDIS_CLUSTER_MODE_ENABLED === "1",
    }),
    ORG_PROVISIONING_VISIBILITY_TIMEOUT_MS
  )
);

const pushEnvLimit = reconcilingPush(prisma, (environment, limit) =>
  updateEnvConcurrencyLimits(environment, limit)
);

async function createRootEnvironment(
  organization: Organization,
  project: Project,
  type: "STAGING" | "PREVIEW"
) {
  const [error, environment] = await tryCatch(
    createEnvironment({ organization, project, type, isBranchableEnvironment: type === "PREVIEW" })
  );

  if (!error) {
    await updateEnvConcurrencyLimits({ ...environment, organization, project });
    return;
  }

  // Created concurrently by another caller.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
  throw error;
}

const runners: Record<OrgProvisioningJob, (organizationId: string) => Promise<unknown>> = {
  "org.convergeRunsEnabled": (organizationId) =>
    convergeOrgRunsEnabled(organizationId, { prisma, pushEnvLimit }),
  "org.pushConcurrencyLimits": (organizationId) =>
    pushOrgConcurrencyLimits(organizationId, {
      prisma,
      pushEnvLimit,
      recalculatePercentLimits: concurrencySystem.queues.recalculatePercentLimits,
    }),
  "org.provisionStagingEnvironments": (organizationId) =>
    provisionOrgStagingEnvironments(organizationId, {
      prisma,
      pushEnvLimit,
      createEnvironment: createRootEnvironment,
    }),
};

// Locked per org, not per job: runs and concurrency jobs both push run-queue limits.
export async function runOrgProvisioningJob(job: OrgProvisioningJob, organizationId: string) {
  const result = await withLock(organizationId, async () => {
    const [error, value] = await tryCatch(runners[job](organizationId));
    controlPlaneResolver.invalidateOrganization(organizationId);
    if (error) throw error;
    return value;
  });

  logger.info("Org provisioning job finished", { job, organizationId, result });
}

export async function enqueueOrgProvisioningJob(job: OrgProvisioningJob, organizationId: string) {
  // Lazy: a static import would close a module cycle through the worker catalog.
  const { commonWorker } = await import("~/v3/commonWorker.server");

  await commonWorker.enqueue({
    id: `${job}:${organizationId}`,
    job,
    payload: { organizationId },
  });
}
