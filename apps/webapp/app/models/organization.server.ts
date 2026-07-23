import type {
  Organization,
  OrgMember,
  Prisma,
  Project,
  RuntimeEnvironment,
  User,
} from "@trigger.dev/database";
import { tryCatch } from "@trigger.dev/core/utils";
import { customAlphabet } from "nanoid";
import { generate } from "random-words";
import slug from "slug";
import { $replica, prisma, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { featuresForUrl } from "~/features.server";
import { createApiKeyForEnv, createPkApiKeyForEnv, envSlug } from "./api-key.server";
import {
  getDefaultEnvironmentConcurrencyLimit,
  isBillingConfigured,
  setBillingAlert,
} from "~/services/platform.v3.server";
import { buildDefaultBillingAlerts } from "~/services/billingAlertsDefaults.server";
import { enqueueAttioWorkspaceSync } from "~/services/attio.server";
import { logger } from "~/services/logger.server";
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
      // Managed-cloud orgs start deactivated so they're routed through
      // select-plan, which provisions their billing entitlement and activates
      // them. Self-hosters have no billing gate, so they're active immediately.
      isActivated: !features.isManagedCloud,
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

  // Awaited so the seed can't land after the user's first alert edit.
  await seedDefaultBillingAlerts(organization.id);

  return { ...organization };
}

// The platform client has no request timeout; don't let a slow billing backend stall org creation.
const SEED_ALERTS_TIMEOUT_MS = 5_000;

/** Seed default billing alerts for a new org. Never fails org creation. */
async function seedDefaultBillingAlerts(organizationId: string): Promise<void> {
  if (!isBillingConfigured()) {
    return;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out")), SEED_ALERTS_TIMEOUT_MS);
  });

  const [error] = await tryCatch(
    Promise.race([setBillingAlert(organizationId, buildDefaultBillingAlerts()), timeout]).finally(
      () => clearTimeout(timer)
    )
  );
  if (error) {
    logger.warn("Failed to seed default billing alerts for new org", {
      organizationId,
      error: error instanceof Error ? error.message : error,
    });
  }
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
