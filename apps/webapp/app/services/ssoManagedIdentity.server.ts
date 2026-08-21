import type { OrgSsoStatus } from "@trigger.dev/plugins";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { ssoController } from "~/services/sso.server";

/**
 * Who owns a user's email address.
 *
 * - `user`    - theirs to change.
 * - `idp`     - an identity provider asserts it, so changing it here would break
 *               their next login.
 * - `unknown` - SSO couldn't be reached. Refuse the write, but don't claim an IdP
 *               owns it.
 */
export type EmailOwnership = "user" | "idp" | "unknown";

/**
 * An org owns a member's email only when SSO is enforced, a connection is live,
 * and the member's domain is one the org has verified. Enforcement alone isn't
 * enough: members on other domains (contractors) keep their own sign-in, so
 * their address is still theirs.
 */
export function idpOwnsEmailDomain(status: OrgSsoStatus, emailDomain: string): boolean {
  if (!status.enforced) return false;
  if (!status.connections.some((connection) => connection.state === "active")) return false;
  return status.domains.some(
    (domain) => domain.verified && domain.domain.toLowerCase() === emailDomain
  );
}

function domainOf(email: string): string | undefined {
  const domain = email.toLowerCase().trim().split("@")[1];
  return domain || undefined;
}

export async function getEmailOwnership(user: {
  id: string;
  email: string;
}): Promise<EmailOwnership> {
  if (!(await ssoController.isUsingPlugin())) {
    return "user";
  }

  const emailDomain = domainOf(user.email);
  if (!emailDomain) {
    return "user";
  }

  const memberships = await prisma.orgMember.findMany({
    where: { userId: user.id, organization: { deletedAt: null } },
    select: { organizationId: true },
  });

  if (memberships.length === 0) {
    return "user";
  }

  const statuses = await Promise.all(
    memberships.map((membership) => ssoController.getStatus(membership.organizationId))
  );

  // A definite answer from any org wins over an org we couldn't read, so one
  // unreachable org doesn't mask a real IdP claim - or block a write on its own.
  let unreadable = false;

  for (const [index, status] of statuses.entries()) {
    if (status.isErr()) {
      unreadable = true;
      logger.warn("SSO status lookup failed; can't establish email ownership", {
        userId: user.id,
        organizationId: memberships[index].organizationId,
        reason: status.error,
      });
      continue;
    }

    if (idpOwnsEmailDomain(status.value, emailDomain)) {
      return "idp";
    }
  }

  return unreadable ? "unknown" : "user";
}
