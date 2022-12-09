import type { User, Organization } from ".prisma/client";
import { prisma } from "~/db.server";
import slug from "slug";
import { customAlphabet } from "nanoid";

export type { Organization } from ".prisma/client";

const nanoid = customAlphabet("1234567890abcdef", 4);

export function getOrganizationFromSlug({
  userId,
  slug,
}: Pick<Organization, "slug"> & {
  userId: User["id"];
}) {
  return prisma.organization.findFirst({
    include: {
      workflows: {
        select: {
          id: true,
          title: true,
          slug: true,
        },
      },
    },
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
  return await createOrganization({
    title: "Personal Workspace",
    userId: user.id,
    desiredSlug: "personal",
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
    desiredSlug = `${slug(title)}-${nanoid(4)}`;
  } else {
    desiredSlug = `${desiredSlug}-${nanoid(4)}`;
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

  for (let i = 1; i < 100; i++) {
    const alternativeSlug = `${desiredSlug}-${nanoid(4)}`;
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
