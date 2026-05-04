import type {
  Organization,
  OrgMember,
  Prisma,
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
import { getDefaultEnvironmentConcurrencyLimit } from "~/services/platform.v3.server";
import { logger } from "~/services/logger.server";
import { provisionBasinForOrg } from "~/services/realtime/streamBasinProvisioner.server";
export type { Organization };

const nanoid = customAlphabet("1234567890abcdef", 4);

export async function createOrganization(
  {
    title,
    userId,
    companySize,
    onboardingData,
    avatar,
  }: Pick<Organization, "title" | "companySize"> & {
    userId: User["id"];
    onboardingData?: Prisma.InputJsonValue;
    avatar?: Prisma.InputJsonValue;
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
        onboardingData,
        avatar,
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
      onboardingData: onboardingData ?? undefined,
      avatar: avatar ?? undefined,
      maximumConcurrencyLimit: env.DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT,
      members: {
        create: {
          userId: userId,
          role: "ADMIN",
        },
      },
      v3Enabled: true,
    },
    include: {
      members: true,
    },
  });

  // Provision the org's S2 basin synchronously so the very first run
  // gets `streamBasinName` stamped via the existing org read. New orgs
  // get the default retention; the plan-change path updates retention
  // later if the operator runs a billing-aware install. Soft-fail on
  // S2 errors so a transient outage doesn't block signup — the
  // backfill reconciler picks up any org left with `streamBasinName: null`.
  // No-op when `REALTIME_STREAMS_PER_ORG_BASINS_ENABLED=false` (OSS mode).
  try {
    await provisionBasinForOrg({
      id: organization.id,
      slug: organization.slug,
      streamBasinName: organization.streamBasinName,
      // No `retention` — provisioner uses `defaultRetention()`.
    });
  } catch (error) {
    logger.warn("[createOrganization] streamBasin provisioning failed; backfill will retry", {
      orgId: organization.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

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

  const limit = await getDefaultEnvironmentConcurrencyLimit(organization.id, type);

  return await prismaClient.runtimeEnvironment.create({
    data: {
      slug,
      apiKey,
      pkApiKey,
      shortcode,
      autoEnableInternalSources: type !== "DEVELOPMENT",
      maximumConcurrencyLimit: limit,
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
