import { Prisma, prisma } from "~/db.server";
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

// Completes a JIT role assignment for an ALREADY-existing membership whose
// RBAC role never got applied. This is a no-op when a role is already
// assigned, so it can never demote a deliberately-set role — it only fills
// in the gap left by an interrupted provision (see `ensureOrgMember`). Always
// best-effort: a valid membership already exists, so a failure here is logged
// and swallowed rather than thrown.
async function healMissingRoleAssignment(params: {
  userId: string;
  organizationId: string;
  roleId: string;
  source: EnsureOrgMemberParams["source"];
}): Promise<void> {
  const { userId, organizationId, roleId, source } = params;

  const currentRole = await rbac.getUserRole({ userId, organizationId });
  if (currentRole !== null) return;

  const result = await rbac.setUserRole({ userId, organizationId, roleId });
  if (!result.ok) {
    logger.warn("ensureOrgMember.setUserRole failed while healing unassigned membership", {
      source,
      userId,
      organizationId,
      roleId,
      error: result.error,
    });
  }
}

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
    // Existing membership is normally a pure no-op: we don't re-touch the
    // role, since a user JIT fires for again may have been deliberately
    // promoted and must not be demoted back to the JIT default.
    //
    // The one exception is self-healing a half-provisioned row. The create +
    // setUserRole + compensating delete below are not transactional (the RBAC
    // plugin writes on its own connection, so a single DB transaction isn't
    // possible). If setUserRole failed AND that compensating delete also
    // failed, the placeholder MEMBER row is orphaned — and this findFirst
    // would short-circuit every future login, stranding the user on the
    // placeholder role forever. So when a JIT role is requested but the RBAC
    // layer shows no role assigned, complete the assignment now. It's gated on
    // "no role assigned", so it can never demote a real one.
    if (roleId !== null) {
      await healMissingRoleAssignment({ userId, organizationId, roleId, source });
    }
    return { created: false, orgMemberId: existing.id };
  }

  // Two concurrent JIT/invite flows can both miss the findFirst above and
  // race to create the same (userId, organizationId) row; the unique
  // constraint makes one lose with P2002. Treat that as the idempotent
  // "already a member" case rather than letting it break sign-in.
  let member: { id: string };
  try {
    member = await prisma.orgMember.create({
      data: {
        userId,
        organizationId,
        role: "MEMBER",
      },
      select: { id: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existingAfterConflict = await prisma.orgMember.findFirst({
        where: { userId, organizationId },
        select: { id: true },
      });
      if (existingAfterConflict) {
        return { created: false, orgMemberId: existingAfterConflict.id };
      }
    }
    throw error;
  }

  if (roleId !== null) {
    const result = await rbac.setUserRole({ userId, organizationId, roleId });
    if (!result.ok) {
      // The membership was just created with the legacy `MEMBER` enum role as
      // a placeholder; the intended RBAC role failed to apply. Leaving the row
      // in place would grant the user `MEMBER` access — potentially broader
      // than the configured (e.g. restrictive) JIT default role they were
      // supposed to get. Roll back so we never half-provision into an
      // unintended privilege level, then throw so the caller can decide
      // whether to skip provisioning or fail the flow.
      logger.warn("ensureOrgMember.setUserRole failed; rolling back membership", {
        source,
        userId,
        organizationId,
        roleId,
        error: result.error,
      });
      await prisma.orgMember.delete({ where: { id: member.id } });
      throw new Error(`ensureOrgMember: failed to apply role ${roleId}: ${result.error}`);
    }
  }

  return { created: true, orgMemberId: member.id };
}
