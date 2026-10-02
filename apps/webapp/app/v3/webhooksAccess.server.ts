import { $replica, prisma, type PrismaClientOrTransaction } from "~/db.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { flag, makeFlag } from "~/v3/featureFlags.server";

/**
 * Whether the org has webhooks: a global FeatureFlag or a per-org override enables it, and admins
 * and impersonators always have it.
 */
export async function hasWebhooksAccess(
  user: { admin: boolean; isImpersonating: boolean },
  organizationId: string
) {
  if (user.admin || user.isImpersonating) return true;
  const org = await $replica.organization.findFirst({
    where: { id: organizationId },
    select: { featureFlags: true },
  });
  return flag({
    key: FEATURE_FLAG.hasWebhooksAccess,
    defaultValue: false,
    overrides: (org?.featureFlags as Record<string, unknown>) ?? {},
  });
}

/** 404 unless {@link hasWebhooksAccess}. */
export async function requireWebhooksAccess(
  user: { admin: boolean; isImpersonating: boolean },
  organizationId: string
) {
  if (!(await hasWebhooksAccess(user, organizationId))) {
    throw new Response("Not found", { status: 404 });
  }
}

/**
 * Whether the org itself has webhooks, with no admin bypass: for paths that act as the org rather
 * than a dashboard user, like a deploy declaring endpoints.
 */
export async function organizationHasWebhooksAccess(
  organizationId: string,
  client: PrismaClientOrTransaction = prisma
) {
  const org = await client.organization.findFirst({
    where: { id: organizationId },
    select: { featureFlags: true },
  });
  return makeFlag(client)({
    key: FEATURE_FLAG.hasWebhooksAccess,
    defaultValue: false,
    overrides: (org?.featureFlags as Record<string, unknown>) ?? {},
  });
}
