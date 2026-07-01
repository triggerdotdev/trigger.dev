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
import { $replica, prisma, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { featuresForUrl } from "~/features.server";
import { createApiKeyForEnv, createPkApiKeyForEnv, envSlug } from "./api-key.server";
import { getDefaultEnvironmentConcurrencyLimit } from "~/services/platform.v3.server";
import { enqueueAttioWorkspaceSync } from "~/services/attio.server";
import {
  applyBillingLimitPauseAfterEnvCreate,
  getInitialEnvPauseStateForBillingLimit,
} from "~/v3/services/billingLimit/getInitialEnvPauseStateForBillingLimit.server";
export type { Organization };

const nanoid = customAlphabet("1234567890abcdef", 4);

/**
 * Resolve an organization id from its slug for use as an RBAC auth scope.
 * Reads the replica first (the common case) and falls back to the primary on a
 * miss, so replica lag never leaves a real org unresolved, which the dashboard
 * route builder treats as an unauthorized request.
 */
export async function resolveOrgIdFromSlug(slug: string): Promise<string | null> {
  const fromReplica = await $replica.organization.findFirst({
    where: { slug },
    select: { id: true },
  });
  if (fromReplica) {
    return fromReplica.id;
  }

  const fromPrimary = await prisma.organization.findFirst({
    where: { slug },
    select: { id: true },
  });
  return fromPrimary?.id ?? null;
}

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

  const _features = featuresForUrl(new URL(env.APP_ORIGIN));

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

  // Fire-and-forget; never blocks org creation.
  void enqueueAttioWorkspaceSync({
    orgId: organization.id,
    title: organization.title,
    slug: organization.slug,
    companySize: organization.companySize,
    createdAt: organization.createdAt,
    adminUserId: userId,
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
  /** When set, skips billing lookup — caller must supply the limit for this org + type. */
  maximumConcurrencyLimit,
}: {
  organization: Pick<Organization, "id" | "maximumConcurrencyLimit">;
  project: Pick<Project, "id">;
  type: RuntimeEnvironment["type"];
  isBranchableEnvironment?: boolean;
  member?: OrgMember;
  prismaClient?: PrismaClientOrTransaction;
  maximumConcurrencyLimit?: number;
}) {
  const slug = envSlug(type);
  const apiKey = createApiKeyForEnv(type);
  const pkApiKey = createPkApiKeyForEnv(type);
  const shortcode = createShortcode().join("-");

  const limit =
    maximumConcurrencyLimit ?? (await getDefaultEnvironmentConcurrencyLimit(organization.id, type));
  const billingPause = await getInitialEnvPauseStateForBillingLimit(organization.id, type);

  const environment = await prismaClient.runtimeEnvironment.create({
    data: {
      slug,
      apiKey,
      pkApiKey,
      shortcode,
      autoEnableInternalSources: type !== "DEVELOPMENT",
      maximumConcurrencyLimit: limit,
      paused: billingPause.paused,
      pauseSource: billingPause.pauseSource,
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
    include: {
      organization: true,
      project: true,
    },
  });

  await applyBillingLimitPauseAfterEnvCreate(environment);

  return environment;
}

function createShortcode() {
  return generate({ exactly: 2 });
}
