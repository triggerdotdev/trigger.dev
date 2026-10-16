import {
  boundedIn,
  type Organization,
  type Prisma,
  type PrismaClient,
  type Project,
  type RuntimeEnvironment,
} from "@trigger.dev/database";
import { tryCatch } from "@trigger.dev/core/v3";
import pMap from "p-map";

const ORG_PROVISIONING_PARALLELISM = 10;

export type ProvisioningEnvironment = RuntimeEnvironment & {
  organization: Organization;
  project: Project;
};

export type PushEnvLimit = (environment: ProvisioningEnvironment, limit: number) => Promise<void>;

const RECONCILE_ROUNDS = 3;

/**
 * Pause and resume write the row before pushing, so re-reading until it matches our last push
 * guarantees the stored state lands last. Throws if it keeps changing, so the job retries.
 */
export function reconcilingPush(prisma: PrismaClient, push: PushEnvLimit): PushEnvLimit {
  return async (environment, limit) => {
    let target = environment;
    let pushed = limit;

    for (let round = 0; round < RECONCILE_ROUNDS; round++) {
      await push(target, pushed);

      const current = await prisma.runtimeEnvironment.findFirst({
        where: { id: environment.id },
        select: { paused: true, maximumConcurrencyLimit: true },
      });
      if (!current) return;

      const stored = current.paused ? 0 : current.maximumConcurrencyLimit;
      if (stored === pushed) return;

      target = { ...target, ...current };
      pushed = stored;
    }

    throw new Error(`Environment ${environment.id} kept changing while its limit was pushed`);
  };
}

export type ConcurrencyLimits = {
  organization: number;
  development?: number;
  staging?: number;
  production?: number;
};

// Pushes every env in the target state, not just changed ones, so a retry repairs a crashed run.
export async function convergeOrgRunsEnabled(
  organizationId: string,
  deps: {
    prisma: PrismaClient;
    pushEnvLimit: PushEnvLimit;
  }
): Promise<{ updated: number; pushed: number }> {
  const { prisma, pushEnvLimit } = deps;

  const organization = await prisma.organization.findFirst({ where: { id: organizationId } });
  if (!organization) return { updated: 0, pushed: 0 };

  const enable = organization.runsEnabled;
  const nonDevEnvironments = {
    organizationId,
    type: { not: "DEVELOPMENT" },
    archivedAt: null,
  } satisfies Prisma.RuntimeEnvironmentWhereInput;

  // Billing-limit pauses are left to the billing-limit flow.
  const { count } = await prisma.runtimeEnvironment.updateMany({
    where: {
      ...nonDevEnvironments,
      ...(enable ? { paused: true, pauseSource: null } : { paused: false }),
    },
    data: { paused: !enable },
  });

  const settled = await prisma.runtimeEnvironment.findMany({
    where: { ...nonDevEnvironments, paused: !enable },
    include: { project: true },
  });

  let failed = 0;
  await pMap(
    settled,
    async (env) => {
      const limit = enable ? env.maximumConcurrencyLimit : 0;
      const [error] = await tryCatch(pushEnvLimit({ ...env, organization }, limit));
      if (error) failed++;
    },
    { concurrency: ORG_PROVISIONING_PARALLELISM }
  );

  if (failed > 0) {
    throw new Error(
      `Failed to ${enable ? "resume" : "pause"} ${failed} of ${settled.length} environments`
    );
  }

  return { updated: count, pushed: settled.length };
}

export async function setOrgConcurrencyLimits(
  organizationId: string,
  limits: ConcurrencyLimits,
  prisma: PrismaClient
) {
  const byType = [
    { types: ["DEVELOPMENT"] as const, limit: limits.development },
    { types: ["STAGING", "PREVIEW"] as const, limit: limits.staging },
    { types: ["PRODUCTION"] as const, limit: limits.production },
  ];

  await prisma.organization.update({
    where: { id: organizationId },
    data: { maximumConcurrencyLimit: limits.organization },
  });

  for (const { types, limit } of byType) {
    if (!limit) continue;
    await prisma.runtimeEnvironment.updateMany({
      where: { organizationId, type: { in: boundedIn([...types]) }, project: { version: "V3" } },
      data: { maximumConcurrencyLimit: limit },
    });
  }
}

export async function pushOrgConcurrencyLimits(
  organizationId: string,
  deps: {
    prisma: PrismaClient;
    pushEnvLimit: PushEnvLimit;
    recalculatePercentLimits: (environment: ProvisioningEnvironment) => Promise<{ failed: number }>;
  }
): Promise<{ pushed: number }> {
  const { prisma, pushEnvLimit, recalculatePercentLimits } = deps;

  const organization = await prisma.organization.findFirst({ where: { id: organizationId } });
  if (!organization) return { pushed: 0 };

  const environments = await prisma.runtimeEnvironment.findMany({
    where: { organizationId, archivedAt: null, project: { version: "V3", deletedAt: null } },
    include: { project: true },
  });

  let failed = 0;
  await pMap(
    environments,
    async (env) => {
      const environment = { ...env, organization };
      const [pushError] = await tryCatch(
        pushEnvLimit(environment, env.paused ? 0 : env.maximumConcurrencyLimit)
      );
      const [recalcError, recalc] = await tryCatch(recalculatePercentLimits(environment));
      if (pushError || recalcError || recalc.failed > 0) failed++;
    },
    { concurrency: ORG_PROVISIONING_PARALLELISM }
  );

  if (failed > 0) {
    throw new Error(
      `Failed to push concurrency for ${failed} of ${environments.length} environments`
    );
  }

  return { pushed: environments.length };
}

export async function provisionOrgStagingEnvironments(
  organizationId: string,
  deps: {
    prisma: PrismaClient;
    createEnvironment: (
      organization: Organization,
      project: Project,
      type: "STAGING" | "PREVIEW"
    ) => Promise<void>;
    pushEnvLimit: PushEnvLimit;
  }
): Promise<{ created: number; projects: number }> {
  const { prisma, createEnvironment, pushEnvLimit } = deps;

  const organization = await prisma.organization.findFirst({
    where: { id: organizationId },
    include: {
      projects: {
        where: { deletedAt: null },
        include: {
          environments: {
            where: { type: { in: ["STAGING", "PREVIEW"] }, parentEnvironmentId: null },
          },
        },
      },
    },
  });
  if (!organization) return { created: 0, projects: 0 };

  const { projects, ...org } = organization;
  const work = projects.flatMap((project) =>
    (["STAGING", "PREVIEW"] as const).map((type) => ({
      project,
      type,
      existing: project.environments.find((env) => env.type === type),
    }))
  );

  let created = 0;
  await pMap(
    work,
    async ({ project, type, existing }) => {
      if (existing) {
        const limit = existing.paused ? 0 : existing.maximumConcurrencyLimit;
        await pushEnvLimit({ ...existing, organization: org, project }, limit);
        return;
      }
      await createEnvironment(org, project, type);
      created++;
    },
    { concurrency: ORG_PROVISIONING_PARALLELISM }
  );

  return { created, projects: projects.length };
}
