import type { AuthenticatedEnvironment } from "@internal/run-engine";
import type { Prisma, PrismaClientOrTransaction, RuntimeEnvironment } from "@trigger.dev/database";
import { $replica, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { getUsername } from "~/utils/username";
import { sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";

export type { RuntimeEnvironment };

// Prisma include shape that maps cleanly to the slim AuthenticatedEnvironment.
// Use this everywhere we fetch an env that flows to handlers — keeps the
// returned shape consistent (and the Decimal coercion in toAuthenticated()
// strips Prisma's Decimal class from the public surface).
const authIncludeBase = {
  project: true,
  organization: true,
  orgMember: {
    select: {
      userId: true,
      user: { select: { id: true, displayName: true, name: true } },
    },
  },
} satisfies Prisma.RuntimeEnvironmentInclude;

const authIncludeWithParent = {
  ...authIncludeBase,
  parentEnvironment: { select: { id: true, apiKey: true } },
} satisfies Prisma.RuntimeEnvironmentInclude;

type PrismaEnvWithAuth = Prisma.RuntimeEnvironmentGetPayload<{ include: typeof authIncludeBase }>;
type PrismaEnvWithAuthAndParent = Prisma.RuntimeEnvironmentGetPayload<{
  include: typeof authIncludeWithParent;
}>;

// Coerce a Prisma RuntimeEnvironment payload to the slim
// AuthenticatedEnvironment shape. Drops the columns handlers don't read
// and converts `concurrencyLimitBurstFactor` from Prisma's Decimal to a
// plain number (lossless at this scale). The optional union accepts both
// query shapes — with parentEnvironment loaded, or without it.
function toAuthenticated(
  env: PrismaEnvWithAuth | PrismaEnvWithAuthAndParent,
): AuthenticatedEnvironment {
  return {
    id: env.id,
    slug: env.slug,
    type: env.type,
    apiKey: env.apiKey,
    organizationId: env.organizationId,
    projectId: env.projectId,
    orgMemberId: env.orgMemberId,
    parentEnvironmentId: env.parentEnvironmentId,
    branchName: env.branchName,
    archivedAt: env.archivedAt,
    paused: env.paused,
    shortcode: env.shortcode,
    maximumConcurrencyLimit: env.maximumConcurrencyLimit,
    // Coerce Prisma's Decimal to a plain number — the slim type accepts
    // both, but downstream consumers shouldn't have to narrow before
    // doing arithmetic. Lossless at this scale (Decimal(4,2)).
    concurrencyLimitBurstFactor: env.concurrencyLimitBurstFactor.toNumber(),
    builtInEnvironmentVariableOverrides: env.builtInEnvironmentVariableOverrides,
    createdAt: env.createdAt,
    updatedAt: env.updatedAt,
    project: {
      id: env.project.id,
      slug: env.project.slug,
      name: env.project.name,
      externalRef: env.project.externalRef,
      engine: env.project.engine,
      deletedAt: env.project.deletedAt,
      defaultWorkerGroupId: env.project.defaultWorkerGroupId,
      organizationId: env.project.organizationId,
      builderProjectId: env.project.builderProjectId,
    },
    organization: {
      id: env.organization.id,
      slug: env.organization.slug,
      title: env.organization.title,
      streamBasinName: env.organization.streamBasinName,
      maximumConcurrencyLimit: env.organization.maximumConcurrencyLimit,
      runsEnabled: env.organization.runsEnabled,
      maximumDevQueueSize: env.organization.maximumDevQueueSize,
      maximumDeployedQueueSize: env.organization.maximumDeployedQueueSize,
      featureFlags: env.organization.featureFlags,
      apiRateLimiterConfig: env.organization.apiRateLimiterConfig,
      batchRateLimitConfig: env.organization.batchRateLimitConfig,
      batchQueueConcurrencyConfig: env.organization.batchQueueConcurrencyConfig,
    },
    orgMember: env.orgMember,
    parentEnvironment: "parentEnvironment" in env ? env.parentEnvironment : null,
  };
}

export async function findEnvironmentByApiKey(
  apiKey: string,
  branchName: string | undefined
): Promise<AuthenticatedEnvironment | null> {
  const include = {
    ...authIncludeBase,
    childEnvironments: branchName
      ? {
          where: {
            branchName: sanitizeBranchName(branchName),
            archivedAt: null,
          },
        }
      : undefined,
  } satisfies Prisma.RuntimeEnvironmentInclude;

  let environment = await $replica.runtimeEnvironment.findFirst({
    where: {
      apiKey,
    },
    include,
  });

  // Fall back to keys that were revoked within the grace window
  if (!environment) {
    const revokedApiKey = await $replica.revokedApiKey.findFirst({
      where: {
        apiKey,
        expiresAt: { gt: new Date() },
      },
      include: {
        runtimeEnvironment: { include },
      },
    });

    environment = revokedApiKey?.runtimeEnvironment ?? null;
  }

  if (!environment) {
    return null;
  }

  //don't return deleted projects
  if (environment.project.deletedAt !== null) {
    return null;
  }

  if (environment.type === "PREVIEW") {
    if (!branchName) {
      logger.warn("findEnvironmentByApiKey(): Preview env with no branch name provided", {
        environmentId: environment.id,
      });
      return null;
    }

    const childEnvironment = environment.childEnvironments.at(0);

    if (childEnvironment) {
      return toAuthenticated({
        ...childEnvironment,
        apiKey: environment.apiKey,
        orgMember: environment.orgMember,
        organization: environment.organization,
        project: environment.project,
      });
    }

    //A branch was specified but no child environment was found
    return null;
  }

  return toAuthenticated(environment);
}

/** @deprecated We don't use public api keys anymore */
export async function findEnvironmentByPublicApiKey(
  apiKey: string,
  branchName: string | undefined
): Promise<AuthenticatedEnvironment | null> {
  const environment = await $replica.runtimeEnvironment.findFirst({
    where: {
      pkApiKey: apiKey,
    },
    include: authIncludeBase,
  });

  if (!environment || environment.project.deletedAt !== null) {
    return null;
  }

  return toAuthenticated(environment);
}

export async function findEnvironmentById(id: string): Promise<AuthenticatedEnvironment | null> {
  const environment = await $replica.runtimeEnvironment.findFirst({
    where: {
      id,
    },
    include: authIncludeWithParent,
  });

  if (!environment || environment.project.deletedAt !== null) {
    return null;
  }

  return toAuthenticated(environment);
}

export async function findEnvironmentBySlug(
  projectId: string,
  envSlug: string,
  userId: string
): Promise<AuthenticatedEnvironment | null> {
  const environment = await $replica.runtimeEnvironment.findFirst({
    where: {
      projectId: projectId,
      slug: envSlug,
      OR: [
        {
          type: {
            in: ["PREVIEW", "STAGING", "PRODUCTION"],
          },
        },
        {
          type: "DEVELOPMENT",
          orgMember: {
            userId,
          },
        },
      ],
    },
    include: authIncludeBase,
  });
  return environment ? toAuthenticated(environment) : null;
}

export async function findEnvironmentFromRun(
  runId: string,
  tx?: PrismaClientOrTransaction
): Promise<AuthenticatedEnvironment | null> {
  const taskRun = await (tx ?? $replica).taskRun.findFirst({
    where: {
      id: runId,
    },
    include: {
      runtimeEnvironment: { include: authIncludeBase },
    },
  });
  return taskRun?.runtimeEnvironment ? toAuthenticated(taskRun.runtimeEnvironment) : null;
}

export async function createNewSession(
  environment: Pick<RuntimeEnvironment, "id">,
  ipAddress: string
) {
  const session = await prisma.runtimeEnvironmentSession.create({
    data: {
      environmentId: environment.id,
      ipAddress,
    },
  });

  await prisma.runtimeEnvironment.update({
    where: {
      id: environment.id,
    },
    data: {
      currentSessionId: session.id,
    },
  });

  return session;
}

export async function disconnectSession(environmentId: string) {
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: environmentId,
    },
  });

  if (!environment || !environment.currentSessionId) {
    return null;
  }

  const session = await prisma.runtimeEnvironmentSession.update({
    where: {
      id: environment.currentSessionId,
    },
    data: {
      disconnectedAt: new Date(),
    },
  });

  await prisma.runtimeEnvironment.update({
    where: {
      id: environment.id,
    },
    data: {
      currentSessionId: null,
    },
  });

  return session;
}

export async function findLatestSession(environmentId: string) {
  const session = await $replica.runtimeEnvironmentSession.findFirst({
    where: {
      environmentId,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return session;
}

export type DisplayableInputEnvironment = Prisma.RuntimeEnvironmentGetPayload<{
  select: {
    id: true;
    type: true;
    slug: true;
    orgMember: {
      select: {
        user: {
          select: {
            id: true;
            name: true;
            displayName: true;
          };
        };
      };
    };
  };
}>;

export function displayableEnvironment(
  environment: DisplayableInputEnvironment,
  userId: string | undefined
) {
  let userName: string | undefined = undefined;

  if (environment.type === "DEVELOPMENT") {
    if (!environment.orgMember) {
      userName = "Deleted";
    } else if (environment.orgMember.user.id !== userId) {
      userName = getUsername(environment.orgMember.user);
    }
  }

  return {
    id: environment.id,
    type: environment.type,
    slug: environment.slug,
    userName,
  };
}

export async function findDisplayableEnvironment(
  environmentId: string,
  userId: string | undefined
) {
  const environment = await $replica.runtimeEnvironment.findFirst({
    where: {
      id: environmentId,
    },
    select: {
      id: true,
      type: true,
      slug: true,
      orgMember: {
        select: {
          user: {
            select: {
              id: true,
              name: true,
              displayName: true,
            },
          },
        },
      },
    },
  });

  if (!environment) {
    return;
  }

  return displayableEnvironment(environment, userId);
}

export async function hasAccessToEnvironment({
  environmentId,
  projectId,
  organizationId,
  userId,
}: {
  environmentId: string;
  projectId: string;
  organizationId: string;
  userId: string;
}): Promise<boolean> {
  const environment = await $replica.runtimeEnvironment.findFirst({
    where: {
      id: environmentId,
      projectId: projectId,
      organizationId: organizationId,
      organization: { members: { some: { userId } } },
    },
  });

  return environment !== null;
}
