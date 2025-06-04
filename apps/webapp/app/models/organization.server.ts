import type {
  Organization,
  OrgMember,
  Project,
  RuntimeEnvironment,
  User,
} from "@trigger.dev/database";
import { customAlphabet } from "nanoid";
import { generate } from "random-words";
import slug from "slug";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { featuresForUrl } from "~/features.server";
import { createApiKeyForEnv, createPkApiKeyForEnv, envSlug } from "./api-key.server";

export type { Organization };

const nanoid = customAlphabet("1234567890abcdef", 4);

export async function createOrganization(
  {
    title,
    userId,
    companySize,
  }: Pick<Organization, "title" | "companySize"> & {
    userId: User["id"];
  },
  attemptCount = 0
): Promise<Organization> {
  if (typeof process.env.BLOCKED_USERS === "string" && process.env.BLOCKED_USERS.includes(userId)) {
    throw new Error("Organization could not be created.");
  }

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
        companySize,
      },
      attemptCount + 1
    );
  }

  const features = featuresForUrl(new URL(env.APP_ORIGIN));

  const organization = await prisma.organization.create({
    data: {
      title,
      slug: uniqueOrgSlug,
      companySize,
      maximumConcurrencyLimit: env.DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT,
      members: {
        create: {
          userId: userId,
          role: "ADMIN",
        },
      },
      v3Enabled: !features.isManagedCloud,
    },
    include: {
      members: true,
    },
  });

  return { ...organization };
}

export async function createEnvironment({
  organization,
  project,
  type,
  isBranchableEnvironment = false,
  member,
  prismaClient = prisma,
}: {
  organization: Pick<Organization, "id" | "maximumConcurrencyLimit">;
  project: Pick<Project, "id">;
  type: RuntimeEnvironment["type"];
  isBranchableEnvironment?: boolean;
  member?: OrgMember;
  prismaClient?: PrismaClientOrTransaction;
}) {
  const slug = envSlug(type);
  const apiKey = createApiKeyForEnv(type);
  const pkApiKey = createPkApiKeyForEnv(type);
  const shortcode = createShortcode().join("-");

  return await prismaClient.runtimeEnvironment.create({
    data: {
      slug,
      apiKey,
      pkApiKey,
      shortcode,
      autoEnableInternalSources: type !== "DEVELOPMENT",
      maximumConcurrencyLimit: organization.maximumConcurrencyLimit / 3,
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
      isBranchableEnvironment,
    },
  });
}

function createShortcode() {
  return generate({ exactly: 2 });
}
