import type { AuthenticatedEnvironment } from "@internal/run-engine";
import type { Prisma, PrismaClientOrTransaction, RuntimeEnvironment } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { sanitizeBranchName } from "~/services/upsertBranch.server";
import { getUsername } from "~/utils/username";

export type { RuntimeEnvironment };

export async function findEnvironmentByApiKey(
  apiKey: string,
  branchName: string | undefined
): Promise<AuthenticatedEnvironment | null> {
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      apiKey,
    },
    include: {
      project: true,
      organization: true,
      orgMember: true,
      childEnvironments: branchName
        ? {
            where: {
              branchName: sanitizeBranchName(branchName),
              archivedAt: null,
            },
          }
        : undefined,
    },
  });

  //don't return deleted projects
  if (environment?.project.deletedAt !== null) {
    return null;
  }

  if (environment.type === "PREVIEW") {
    if (!branchName) {
      logger.error("findEnvironmentByApiKey(): Preview env with no branch name provided", {
        environmentId: environment.id,
      });
      return null;
    }

    const childEnvironment = environment?.childEnvironments.at(0);

    if (childEnvironment) {
      return {
        ...childEnvironment,
        apiKey: environment.apiKey,
        orgMember: environment.orgMember,
        organization: environment.organization,
        project: environment.project,
      };
    }

    //A branch was specified but no child environment was found
    return null;
  }

  return environment;
}

export async function findEnvironmentByPublicApiKey(
  apiKey: string,
  branchName: string | undefined
): Promise<AuthenticatedEnvironment | null> {
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      pkApiKey: apiKey,
    },
    include: {
      project: true,
      organization: true,
      orgMember: true,
    },
  });

  //don't return deleted projects
  if (environment?.project.deletedAt !== null) {
    return null;
  }

  return environment;
}

export async function findEnvironmentById(id: string): Promise<AuthenticatedEnvironment | null> {
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id,
    },
    include: {
      project: true,
      organization: true,
      orgMember: true,
    },
  });

  //don't return deleted projects
  if (environment?.project.deletedAt !== null) {
    return null;
  }

  return environment;
}

export async function findEnvironmentBySlug(
  projectId: string,
  envSlug: string,
  userId: string
): Promise<AuthenticatedEnvironment | null> {
  return prisma.runtimeEnvironment.findFirst({
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
    include: {
      project: true,
      organization: true,
      orgMember: true,
    },
  });
}

export async function findEnvironmentFromRun(
  runId: string,
  tx?: PrismaClientOrTransaction
): Promise<AuthenticatedEnvironment | null> {
  const taskRun = await (tx ?? prisma).taskRun.findFirst({
    where: {
      id: runId,
    },
    include: {
      runtimeEnvironment: {
        include: {
          project: true,
          organization: true,
          orgMember: true,
        },
      },
    },
  });

  if (!taskRun) {
    return null;
  }

  return taskRun?.runtimeEnvironment;
}

export async function createNewSession(environment: RuntimeEnvironment, ipAddress: string) {
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
  const session = await prisma.runtimeEnvironmentSession.findFirst({
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
