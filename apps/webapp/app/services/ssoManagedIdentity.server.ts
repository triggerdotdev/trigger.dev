import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { ssoController } from "~/services/sso.server";

/**
 * Whether a user's identity is owned by an identity provider rather than by the
 * user — true when any organization they belong to has SSO set up with at least
 * one active connection.
 *
 * "Set up with an active connection" is the same thing the SSO settings page
 * calls active (`hasIdpOrg` plus a live connection): a configured-but-dead
 * connection can't sign anyone in, so on its own it doesn't mean the IdP owns
 * the account. This is deliberately NOT the Enterprise plan flag — an org can be
 * on Enterprise without ever configuring SSO, and that org's members own their
 * own email addresses.
 *
 * Any org counts, not just the "current" one: this page has no org in scope, and
 * a user who is in one SSO org and one personal org still authenticates through
 * that IdP.
 *
 * Fails CLOSED. If the SSO plugin can't answer we treat the account as
 * IdP-managed, because the alternative is letting an outage open up a write we
 * can't verify. On OSS (no plugin installed) this short-circuits to `false`
 * before any query runs, so self-hosters pay nothing and never see the branch.
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
