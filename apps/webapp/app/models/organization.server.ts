import type {
  Organization,
  OrgMember,
  Project,
  RuntimeEnvironment,
  User,
} from ".prisma/client";
import { ro } from "date-fns/locale";
import { customAlphabet } from "nanoid";
import slug from "slug";
import { prisma } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { generateTwoRandomWords } from "~/utils/randomWords";

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
      environments: true,
    },
    where: { slug, members: { some: { userId } } },
  });
}

export function getOrganizations({ userId }: { userId: User["id"] }) {
  return prisma.organization.findMany({
    where: { members: { some: { userId } } },
    orderBy: { createdAt: "desc" },
    include: {
      environments: {
        orderBy: { slug: "asc" },
      },
      projects: {
        orderBy: { name: "asc" },
        include: {
          _count: {
            select: {
              jobs: true,
            },
          },
        },
      },
      _count: {
        select: {
          members: true,
        },
      },
    },
  });
}

export async function createOrganization(
  {
    title,
    userId,
    projectName,
  }: Pick<Organization, "title"> & {
    userId: User["id"];
    projectName: string;
  },
  attemptCount = 0
): Promise<Organization & { projects: Project[] }> {
  const uniqueOrgSlug = `${slug(title)}-${nanoid(4)}`;
  const uniqueProjectSlug = `${slug(projectName)}-${nanoid(4)}`;

  const orgWithSameSlug = await prisma.organization.findFirst({
    where: { slug: uniqueOrgSlug },
  });

  const projectWithSameSlug = await prisma.project.findFirst({
    where: { slug: uniqueProjectSlug },
  });

  if (attemptCount > 100) {
    throw new Error(
      `Unable to create organization with slug ${uniqueOrgSlug} after 100 attempts`
    );
  }

  if (orgWithSameSlug || projectWithSameSlug) {
    return createOrganization(
      {
        title,
        userId,
        projectName,
      },
      attemptCount + 1
    );
  }

  const organization = await prisma.organization.create({
    data: {
      title,
      slug: uniqueOrgSlug,
      members: {
        create: {
          userId: userId,
          role: "ADMIN",
        },
      },
      projects: {
        create: {
          name: projectName,
          slug: uniqueProjectSlug,
        },
      },
    },
    include: {
      members: true,
      projects: true,
    },
  });

  const adminMember = organization.members[0];
  const defaultProject = organization.projects[0];

  // Create the dev and prod environments
  await createEnvironment(organization, defaultProject, "PRODUCTION");
  await createEnvironment(
    organization,
    defaultProject,
    "DEVELOPMENT",
    adminMember
  );

  await workerQueue.enqueue("organizationCreated", {
    id: organization.id,
  });

  return organization;
}

export async function createEnvironment(
  organization: Organization,
  project: Project,
  type: RuntimeEnvironment["type"],
  member?: OrgMember
) {
  const slug = envSlug(type);
  const apiKey = createApiKeyForEnv(type);

  return await prisma.runtimeEnvironment.create({
    data: {
      slug,
      apiKey,
      organization: {
        connect: {
          id: organization.id,
        },
      },
      project: {
        connect: {
          id: project.id,
        },
      },
      orgMember: member ? { connect: { id: member.id } } : undefined,
      type,
    },
  });
}

function createApiKeyForEnv(envType: RuntimeEnvironment["type"]) {
  return `tr_${envSlug(envType)}_${apiKeyId(12)}`;
}

function envSlug(environmentType: RuntimeEnvironment["type"]) {
  switch (environmentType) {
    case "DEVELOPMENT": {
      return "dev";
    }
    case "PRODUCTION": {
      return "prod";
    }
    case "STAGING": {
      return "staging";
    }
    case "PREVIEW": {
      return "preview";
    }
  }
}

export async function getOrganizationTeamMembers({
  userId,
  slug,
}: {
  userId: string;
  slug: string;
}) {
  const org = await prisma.organization.findFirst({
    where: { slug, members: { some: { userId } } },
    select: {
      members: {
        select: {
          id: true,
          role: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
            },
          },
        },
      },
    },
  });

  if (!org) {
    return null;
  }

  return org.members;
}

export async function removeTeamMember({
  userId,
  slug,
  memberId,
}: {
  userId: string;
  slug: string;
  memberId: string;
}) {
  const org = await prisma.organization.findFirst({
    where: { slug, members: { some: { userId } } },
  });

  if (!org) {
    throw new Error("User does not have access to this organization");
  }

  return prisma.orgMember.delete({
    where: {
      id: memberId,
    },
    include: {
      organization: true,
      user: true,
    },
  });
}
