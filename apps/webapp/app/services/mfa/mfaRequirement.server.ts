import { LRUCache } from "lru-cache";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import type { MfaStepUpAction } from "~/utils/mfaStepUp";
import { accountSecurityPath } from "~/utils/pathBuilder";

// Only users who have MFA, and platform admins, are cached: an org's requirement can't lock them
// out. Everyone else is checked on every request, so joining an org or the org turning
// enforcement on applies at once.
// shortcut: a user who turns MFA off stays cached for up to 30s; that can't skip a lockout, since
// MFA can't be turned off while an org requires it.
const hasMfaCache = new LRUCache<string, true>({ max: 100_000, ttl: 30_000 });

/** True when the user has no MFA, isn't a platform admin, and belongs to an org that requires it. */
export async function isMfaSetupRequired(
  userId: string,
  client: PrismaClientOrTransaction = prisma
): Promise<boolean> {
  if (hasMfaCache.has(userId)) return false;

  const user = await client.user.findFirst({
    where: { id: userId },
    select: {
      mfaEnabledAt: true,
      admin: true,
      orgMemberships: {
        where: { organization: { mfaRequired: true, deletedAt: null } },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!user) return false;
  if (user.mfaEnabledAt || user.admin) {
    hasMfaCache.set(userId, true);
    return false;
  }
  return user.orgMemberships.length > 0;
}

/** True when any of the user's orgs requires MFA, whether or not the user has it. */
export async function isMfaRequiredByOrganization(
  userId: string,
  client: PrismaClientOrTransaction = prisma
): Promise<boolean> {
  const count = await client.orgMember.count({
    where: { userId, organization: { mfaRequired: true, deletedAt: null } },
  });
  return count > 0;
}

export function mfaSetupRequiredMessage() {
  const origin = env.PUBLIC_APP_ORIGIN ?? env.APP_ORIGIN;
  return `Your organization requires multi-factor authentication. Set it up at ${origin}${accountSecurityPath()} and try again.`;
}

/**
 * The shortest step-up window of the user's orgs that require an MFA check for this action,
 * or undefined when none does. With an `organizationId`, only that org counts; without one
 * (user-level pages such as personal access tokens), every org the user belongs to does.
 */
export async function stepUpWindowMinutes(
  userId: string,
  action: MfaStepUpAction,
  organizationId?: string,
  client: PrismaClientOrTransaction = prisma
): Promise<number | undefined> {
  const orgs = await client.organization.findMany({
    where: {
      ...(organizationId ? { id: organizationId } : {}),
      deletedAt: null,
      mfaStepUpActions: { has: action },
      members: { some: { userId } },
    },
    select: { mfaStepUpWindowMinutes: true },
  });
  if (orgs.length === 0) return undefined;
  return Math.min(...orgs.map((org) => org.mfaStepUpWindowMinutes));
}

export function isMfaVerificationFresh(
  verifiedAt: unknown,
  windowMinutes: number,
  now = Date.now()
): boolean {
  if (typeof verifiedAt !== "number") return false;
  // A future timestamp is clock skew between instances; the session cookie is signed.
  return now - verifiedAt < windowMinutes * 60_000;
}
