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
    },
  });

  //don't return deleted projects
  if (environment?.project.deletedAt !== null) {
    return null;
  }

  return environment;
}
