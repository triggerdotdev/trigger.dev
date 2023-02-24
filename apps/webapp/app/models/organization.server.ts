import type { User, Organization } from ".prisma/client";
import { prisma } from "~/db.server";
import slug from "slug";
import { customAlphabet } from "nanoid";
import { generateTwoRandomWords } from "~/utils/randomWords";
import { taskQueue } from "~/services/messageBroker.server";
import { DEV_ENVIRONMENT, LIVE_ENVIRONMENT } from "~/consts";

export type { Organization } from ".prisma/client";

const nanoid = customAlphabet("1234567890abcdef", 4);
const apiKeyId = customAlphabet(
  "1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  12
);

export function getOrganizationFromSlug({
  userId,
  slug,
}: Pick<Organization, "slug"> & {
  userId: User["id"];
}) {
  return prisma.organization.findFirst({
    include: {
      workflows: {
        include: {
          externalServices: {
            select: {
              service: true,
            },
          },
        },
        where: { isArchived: false },
        orderBy: [
          { disabledAt: { sort: "asc", nulls: "first" } },
          { title: "asc" },
        ],
      },
      environments: true,
    },
    where: { slug, users: { some: { id: userId } } },
  });
}

export function getWorkflowsCreatedSinceDate(
  userId: string,
  slug: string,
  since: Date
) {
  return prisma.workflow.findMany({
    where: {
      organization: {
        users: {
          some: {
            id: userId,
          },
        },
        slug,
      },
      createdAt: {
        gte: since,
      },
    },
  });
}

export function getOrganizations({ userId }: { userId: User["id"] }) {
  return prisma.organization.findMany({
    where: { users: { some: { id: userId } } },
    orderBy: { createdAt: "desc" },
    include: {
      environments: {
        orderBy: { slug: "asc" },
      },
    },
  });
}

export async function createFirstOrganization(user: User) {
  return await createOrganization({
    title: "Personal Workspace",
    userId: user.id,
    desiredSlug: generateTwoRandomWords(),
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

  const uniqueSlug = `${desiredSlug}-${nanoid(4)}`;

  const withSameSlug = await prisma.organization.findFirst({
    where: { slug: uniqueSlug },
  });

  let organization: Organization | undefined = undefined;

  if (withSameSlug == null) {
    organization = await prisma.organization.create({
      data: {
        title,
        slug: uniqueSlug,
        users: {
          connect: {
            id: userId,
          },
        },
      },
    });
  } else {
    const organizationsWithMatchingSlugs =
      await getOrganizationsWithMatchingSlug({
        slug: uniqueSlug,
      });

    for (let i = 1; i < 100; i++) {
      const alternativeSlug = `${desiredSlug}-${nanoid(4)}`;
      if (
        organizationsWithMatchingSlugs.find(
          (organization) => organization.slug === alternativeSlug
        )
      ) {
        continue;
      }

      organization = await prisma.organization.create({
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

      break;
    }
  }

  if (organization) {
    // Create the dev and prod environments
    await createEnvironment(organization, DEV_ENVIRONMENT);
    await createEnvironment(organization, LIVE_ENVIRONMENT);

    await taskQueue.publish("ORGANIZATION_CREATED", {
      id: organization.id,
    });

    return organization;
  }

  throw new Error("Could not create organization with a unique slug");
}

export async function createEnvironment(
  organization: Organization,
  slug: string
) {
  const apiKey = createApiKeyForEnv(slug);

  return await prisma.runtimeEnvironment.create({
    data: {
      slug,
      apiKey,
      organization: {
        connect: {
          id: organization.id,
        },
      },
    },
  });
}

function createApiKeyForEnv(envSlug: string) {
  return `trigger_${envSlug}_${apiKeyId(12)}`;
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
