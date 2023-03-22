import type { RuntimeEnvironment } from ".prisma/client";
import { createCookieSessionStorage } from "@remix-run/node";
import { prisma } from "~/db.server";
import { env } from "~/env.server";

export type { RuntimeEnvironment };

export async function findEnvironmentByApiKey(apiKey: string) {
  const environment = await prisma.runtimeEnvironment.findUnique({
    where: {
      apiKey,
    },
    include: {
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

export async function getRuntimeEnvironment({
  organizationId,
  slug,
}: {
  organizationId: string;
  slug: string;
}) {
  return prisma.runtimeEnvironment.findUnique({
    where: {
      organizationId_slug: {
        organizationId,
        slug,
      },
    },
  });
}

export async function getCurrentRuntimeEnvironment(
  organizationSlug: string,
  environment?: RuntimeEnvironment,
  defaultEnvironment?: string
) {
  if (environment) {
    return environment;
  }

  const organization = await prisma.organization.findUnique({
    where: {
      slug: organizationSlug,
    },
  });

  if (!organization) {
    throw new Response("Not Found", { status: 404 });
  }

  return await prisma.runtimeEnvironment.findUniqueOrThrow({
    where: {
      organizationId_slug: {
        organizationId: organization.id,
        slug: defaultEnvironment ?? "development",
      },
    },
  });
}
