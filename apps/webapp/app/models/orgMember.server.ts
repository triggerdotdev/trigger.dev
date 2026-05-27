import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { rbac } from "~/services/rbac.server";

export type EnsureOrgMemberParams = {
  userId: string;
  organizationId: string;
  // null = use the seeded MEMBER role from the existing enum. A non-null
  // value is an RBAC role id; when an RBAC plugin is installed it gets
  // attached after the OrgMember row is created.
  roleId: string | null;
  source: "sso_jit" | "invite" | "manual";
};

export type EnsureOrgMemberResult = { created: boolean; orgMemberId: string };

// Idempotent OrgMember upsert. If the (userId, organizationId) row
// already exists this is a no-op (returns `{ created: false }`); we do
// NOT touch the existing role to avoid demoting a user that JIT happens
// to fire for again.
//
// Seat-limit enforcement lives at the call sites — every existing
// OrgMember insert in the codebase does its own seat check before
// calling in. This helper deliberately does none (SSO JIT and
// invite-accept are exempt by policy).
export async function ensureOrgMember(
  params: EnsureOrgMemberParams
): Promise<EnsureOrgMemberResult> {
  const { userId, organizationId, roleId, source } = params;

  const existing = await prisma.orgMember.findFirst({
    where: { userId, organizationId },
    select: { id: true },
  });
  if (existing) {
    return { created: false, orgMemberId: existing.id };
  }

  const member = await prisma.orgMember.create({
    data: {
      userId,
      organizationId,
      role: "MEMBER",
    },
    select: { id: true },
  });

  if (roleId !== null) {
    const result = await rbac.setUserRole({ userId, organizationId, roleId });
    if (!result.ok) {
      logger.warn("ensureOrgMember.setUserRole failed", {
        source,
        userId,
        organizationId,
        roleId,
        error: result.error,
      });
    }
  }

  return { created: true, orgMemberId: member.id };
}
