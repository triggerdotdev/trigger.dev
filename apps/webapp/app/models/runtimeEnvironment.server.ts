import type { RuntimeEnvironment } from "@trigger.dev/database";
import { prisma } from "~/db.server";

export type { RuntimeEnvironment };

export async function findEnvironmentByApiKey(apiKey: string) {
  const environment = await prisma.runtimeEnvironment.findUnique({
    where: {
      apiKey,
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

export async function findEnvironmentByPublicApiKey(apiKey: string) {
  const environment = await prisma.runtimeEnvironment.findUnique({
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

export async function findEnvironmentById(id: string) {
  const environment = await prisma.runtimeEnvironment.findUnique({
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

export async function createNewSession(environment: RuntimeEnvironment, ipAddress: string) {
  return prisma.$transaction(async (tx) => {
    const session = await tx.runtimeEnvironmentSession.create({
      data: {
        environmentId: environment.id,
        ipAddress,
      },
    });

    await tx.runtimeEnvironment.update({
      where: {
        id: environment.id,
      },
      data: {
        currentSessionId: session.id,
      },
    });

    return session;
  });
}

export async function disconnectSession(environmentId: string) {
  return prisma.$transaction(async (tx) => {
    const environment = await tx.runtimeEnvironment.findUnique({
      where: {
        id: environmentId,
      },
    });

    if (!environment || !environment.currentSessionId) {
      return null;
    }

    const session = await tx.runtimeEnvironmentSession.update({
      where: {
        id: environment.currentSessionId,
      },
      data: {
        disconnectedAt: new Date(),
      },
    });

    await tx.runtimeEnvironment.update({
      where: {
        id: environment.id,
      },
      data: {
        currentSessionId: null,
      },
    });

    return session;
  });
}
