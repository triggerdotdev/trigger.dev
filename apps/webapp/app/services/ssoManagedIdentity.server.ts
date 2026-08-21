import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { ssoController } from "~/services/sso.server";

/**
 * Whether an identity provider owns this user's identity rather than the user.
 * Any org they belong to counts. Fails closed: if the plugin can't answer, treat
 * the account as IdP-managed rather than allowing an unverifiable write.
 */
export async function isSsoManagedUser(userId: string): Promise<boolean> {
  if (!(await ssoController.isUsingPlugin())) {
    return false;
  }

  const memberships = await prisma.orgMember.findMany({
    where: { userId, organization: { deletedAt: null } },
    select: { organizationId: true },
  });

  if (memberships.length === 0) {
    return false;
  }

  const statuses = await Promise.all(
    memberships.map((membership) => ssoController.getStatus(membership.organizationId))
  );

  for (const [index, status] of statuses.entries()) {
    if (status.isErr()) {
      logger.warn("SSO status lookup failed; treating the account as IdP-managed", {
        userId,
        organizationId: memberships[index].organizationId,
        reason: status.error,
      });
      return true;
    }

    if (status.value.hasIdpOrg && status.value.connections.some((c) => c.state === "active")) {
      return true;
    }
  }

  return false;
}
