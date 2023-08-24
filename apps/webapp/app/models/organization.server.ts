import type {
  Organization,
  OrgMember,
  Project,
  RuntimeEnvironment,
  User,
} from "@trigger.dev/database";
import { customAlphabet } from "nanoid";
import slug from "slug";
import { prisma, PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { createProject } from "./project.server";

export type { Organization };

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
              jobs: {
                where: {
                  internal: false,
                  deletedAt: null,
                },
              },
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

  const orgWithSameSlug = await prisma.organization.findFirst({
    where: { slug: uniqueOrgSlug },
  });

  if (attemptCount > 100) {
    throw new Error(`Unable to create organization with slug ${uniqueOrgSlug} after 100 attempts`);
  }

  if (orgWithSameSlug) {
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
    },
    include: {
      members: true,
    },
  });

  const project = await createProject({
    organizationSlug: organization.slug,
    name: projectName,
    userId,
  });

  return { ...organization, projects: [project] };
}

export async function createEnvironment(
  organization: Organization,
  project: Project,
  type: RuntimeEnvironment["type"],
  member?: OrgMember,
  prismaClient: PrismaClientOrTransaction = prisma
) {
  const slug = envSlug(type);
  const apiKey = createApiKeyForEnv(type);
  const pkApiKey = createPkApiKeyForEnv(type);

  return await prismaClient.runtimeEnvironment.create({
    data: {
      slug,
      apiKey,
      pkApiKey,
      autoEnableInternalSources: type !== "DEVELOPMENT",
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
  return `tr_${envSlug(envType)}_${apiKeyId(20)}`;
}

function createPkApiKeyForEnv(envType: RuntimeEnvironment["type"]) {
  return `pk_${envSlug(envType)}_${apiKeyId(20)}`;
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
