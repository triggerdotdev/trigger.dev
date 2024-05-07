import { nanoid, customAlphabet } from "nanoid";
import slug from "slug";
import { prisma } from "~/db.server";
import type { Project } from "@trigger.dev/database";
import { Organization, createEnvironment } from "./organization.server";
import { env } from "~/env.server";
export type { Project } from "@trigger.dev/database";

const externalRefGenerator = customAlphabet("abcdefghijklmnopqrstuvwxyz", 20);

export async function createProject(
  {
    organizationSlug,
    name,
    userId,
    version,
  }: { organizationSlug: string; name: string; userId: string; version: "v2" | "v3" },
  attemptCount = 0
): Promise<Project & { organization: Organization }> {
  //check the user has permissions to do this
  const organization = await prisma.organization.findFirst({
    where: {
      slug: organizationSlug,
      members: { some: { userId } },
    },
  });

  if (!organization) {
    throw new Error(
      `User ${userId} does not have permission to create a project in organization ${organizationSlug}`
    );
  }

  if (version === "v3") {
    if (!organization.v3Enabled) {
      throw new Error(`Organization can't create v3 projects.`);
    }

    if (!env.V3_ENABLED) {
      throw new Error(`v3 is not available yet.`);
    }
  }

  //ensure the slug is globally unique
  const uniqueProjectSlug = `${slug(name)}-${nanoid(4)}`;
  const projectWithSameSlug = await prisma.project.findFirst({
    where: { slug: uniqueProjectSlug },
  });

  if (attemptCount > 100) {
    throw new Error(`Unable to create project with slug ${uniqueProjectSlug} after 100 attempts`);
  }

  if (projectWithSameSlug) {
    return createProject(
      {
        organizationSlug,
        name,
        userId,
        version,
      },
      attemptCount + 1
    );
  }

  const project = await prisma.project.create({
    data: {
      name,
      slug: uniqueProjectSlug,
      organization: {
        connect: {
          slug: organizationSlug,
        },
      },
      externalRef: `proj_${externalRefGenerator()}`,
      version: version === "v3" ? "V3" : "V2",
    },
    include: {
      organization: {
        include: {
          members: true,
        },
      },
    },
  });

  // Create the dev and prod environments
  await createEnvironment(organization, project, "PRODUCTION");

  if (version === "v2") {
    await createEnvironment(organization, project, "STAGING");
  }

  for (const member of project.organization.members) {
    await createEnvironment(organization, project, "DEVELOPMENT", member);
  }

  return project;
}

export async function findProjectBySlug(orgSlug: string, projectSlug: string, userId: string) {
  // Find the project scoped to the organization, making sure the user belongs to that org
  return await prisma.project.findFirst({
    where: {
      slug: projectSlug,
      organization: {
        slug: orgSlug,
        members: { some: { userId } },
      },
    },
  });
}

export async function findProjectByRef(externalRef: string, userId: string) {
  // Find the project scoped to the organization, making sure the user belongs to that org
  return await prisma.project.findFirst({
    where: {
      externalRef,
      organization: {
        members: { some: { userId } },
      },
    },
  });
}
