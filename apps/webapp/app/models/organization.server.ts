import type { User, Organization } from ".prisma/client";
import { prisma } from "~/db.server";
import slug from "slug";

export function getOrganizationFromSlug({
  userId,
  slug,
}: Pick<Organization, "slug"> & {
  userId: User["id"];
}) {
  return prisma.organization.findFirst({
    where: { slug, users: { some: { id: userId } } },
  });
}

export function getOrganizations({ userId }: { userId: User["id"] }) {
  return prisma.organization.findMany({
    where: { users: { some: { id: userId } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function createFirstOrganization(user: User) {
  //We want the slug to be based on their name if they have one, otherwise their email
  let desiredSlug = user.name ? slug(user.name) : slug(user.email);

  return await createOrganization({
    title: "Personal Workspace",
    userId: user.id,
    desiredSlug,
  });
}

export async function createOrganization({
  title,
  userId,
  desiredSlug,
}: Pick<Organization, "title"> & {
  userId: User["id"];
  desiredSlug?: string;
}) {
  if (desiredSlug === undefined) {
    desiredSlug = slug(title);
  }

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
