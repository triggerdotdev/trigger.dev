import type { Prisma, RuntimeEnvironment } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { getUsername } from "~/utils/username";

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
  const environment = await prisma.runtimeEnvironment.findUnique({
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
