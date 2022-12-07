import type { User, Organization } from ".prisma/client";
import { prisma } from "~/db.server";
import slug from "slug";

export async function createFirstOrganization(userId: string) {
  return await createOrganization({
    title: "Personal Workspace",
    userId: userId,
  });
}

export async function createOrganization({
  title,
  userId,
}: Pick<Organization, "title"> & {
  userId: User["id"];
}) {
  let desiredSlug = slug(title);

  const withSameSlug = await prisma.organization.findFirst({
    where: { slug: desiredSlug },
  });

  if (withSameSlug == null) {
    return prisma.organization.create({
      data: {
        title,
        slug: desiredSlug,
        users: {
          connect: {
            id: userId,
          },
        },
      },
    });
  }

  const organizationsWithMatchingSlugs = await getOrganizationsWithMatchingSlug(
    {
      slug: desiredSlug,
    }
  );

  for (let i = 1; i < 10000; i++) {
    const alternativeSlug = `${desiredSlug}-${i}`;
    if (
      organizationsWithMatchingSlugs.find(
        (organization) => organization.slug === alternativeSlug
      )
    ) {
      continue;
    }

    return prisma.organization.create({
      data: {
        title,
        slug: alternativeSlug,
        users: {
          connect: {
            id: userId,
          },
        },
      },
    });
  }

  throw new Error("Could not create organization with a unique slug");
}

function getOrganizationsWithMatchingSlug({ slug }: { slug: string }) {
  return prisma.organization.findMany({
    where: {
      slug: {
        startsWith: slug,
      },
    },
    select: { slug: true },
    orderBy: { slug: "desc" },
  });
}
