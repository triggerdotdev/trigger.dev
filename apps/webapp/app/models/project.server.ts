import { nanoid } from "nanoid";
import slug from "slug";
import { prisma } from "~/db.server";
import type { Project } from ".prisma/client";
import { Organization } from "./organization.server";
export type { Project } from ".prisma/client";

export async function createProject(
  {
    organizationSlug,
    name,
    userId,
  }: { organizationSlug: string; name: string; userId: string },
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

  //ensure the slug is globally unique
  const uniqueProjectSlug = `${slug(name)}-${nanoid(4)}`;
  const projectWithSameSlug = await prisma.project.findFirst({
    where: { slug: uniqueProjectSlug },
  });

  if (attemptCount > 100) {
    throw new Error(
      `Unable to create project with slug ${uniqueProjectSlug} after 100 attempts`
    );
  }

  if (projectWithSameSlug) {
    return createProject(
      {
        organizationSlug,
        name,
        userId,
      },
      attemptCount + 1
    );
  }

  return prisma.project.create({
    data: {
      name,
      slug: uniqueProjectSlug,
      organization: {
        connect: {
          slug: organizationSlug,
        },
      },
    },
    include: {
      organization: true,
    },
  });
}
