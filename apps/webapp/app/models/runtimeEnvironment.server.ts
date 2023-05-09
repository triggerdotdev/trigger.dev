import type { RuntimeEnvironment } from ".prisma/client";
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

  return environment;
}

export async function getEnvironmentForOrganization(
  organizationSlug: string,
  slug: string
) {
  const organization = await prisma.organization.findUnique({
    where: {
      slug: organizationSlug,
    },
    include: {
      environments: true,
    },
  });

  if (!organization) {
    return;
  }

  const environment = organization.environments.find(
    (environment) => environment.slug === slug
  );

  return environment;
}
