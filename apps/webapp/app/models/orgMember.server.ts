import { Prisma, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { rbac } from "~/services/rbac.server";
import {
  getValidPersonalAccessTokens,
  revokePersonalAccessToken,
} from "~/services/personalAccessToken.server";

export type EnsureOrgMemberParams = {
  userId: string;
  organizationId: string;
  // null = use the seeded MEMBER role from the existing enum. A non-null
  // value is an RBAC role id; when an RBAC plugin is installed it gets
  // attached after the OrgMember row is created.
  roleId: string | null;
  source: "sso_jit" | "invite" | "manual" | "directory_sync";
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

// Find-or-create a User for a directory-provisioned member. Directory Sync
// can provision a user before they have ever logged in, so the User row may
// not exist yet. Email is the natural key (lowercased). New rows are marked
// SSO since the user will authenticate via the org's IdP.
export async function ensureUserForDirectory(params: {
  email: string;
  firstName: string | null;
  lastName: string | null;
}): Promise<{ userId: string }> {
  const email = params.email.toLowerCase().trim();
  const existing = await prisma.user.findFirst({ where: { email }, select: { id: true } });
  if (existing) return { userId: existing.id };

  const name = [params.firstName, params.lastName].filter(Boolean).join(" ").trim() || null;
  // `User.email` is unique, so two concurrent directory events for the same
  // email can both miss the lookup above and race on create; the loser gets
  // P2002. Treat that as the idempotent "already exists" case (same pattern as
  // `ensureOrgMember`) rather than throwing and burning a webhook retry.
  try {
    const created = await prisma.user.create({
      data: {
        email,
        authenticationMethod: "SSO",
        name,
        displayName: name,
      },
      select: { id: true },
    });
    return { userId: created.id };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existingAfterConflict = await prisma.user.findFirst({
        where: { email },
        select: { id: true },
      });
      if (existingAfterConflict) return { userId: existingAfterConflict.id };
    }
    throw error;
  }
}

// Whether the user holds the Owner system role in this org. Owner is the one
// role Directory Sync must never strip (it can't be auto-granted and is the
// org's recovery anchor), so deprovision is guarded against removing the last
// one. Identified by the RBAC system role; OSS-safe (no plugin → not Owner).
function isOwnerRole(role: { name: string; isSystem: boolean } | null): boolean {
  return !!role && role.isSystem && role.name === "Owner";
}

export type RemoveOrgMemberForDirectoryResult =
  | { removed: true }
  | { removed: false; reason: "not_a_member" | "last_owner_protected" };

// Deprovision a directory-removed user from an org: hard-delete the
// OrgMember, drop the RBAC role, force-logout (nextSessionEnd), and revoke
// the user's personal access tokens ONLY when this was their last org (PATs
// are user-global, so revoking on a single-org removal would break their CLI
// access to other orgs). Refuses to remove the org's last Owner.
export async function removeOrgMemberForDirectory(params: {
  userId: string;
  organizationId: string;
}): Promise<RemoveOrgMemberForDirectoryResult> {
  const { userId, organizationId } = params;

  const member = await prisma.orgMember.findFirst({
    where: { userId, organizationId },
    select: { id: true },
  });
  if (!member) return { removed: false, reason: "not_a_member" };

  // Last-Owner guard: never leave the org without an Owner. Resolve every
  // member's RBAC role and bail if this user is the only Owner.
  const members = await prisma.orgMember.findMany({
    where: { organizationId },
    select: { userId: true },
  });
  const roles = await rbac.getUserRoles(
    members.map((m) => m.userId),
    organizationId
  );
  if (isOwnerRole(roles.get(userId) ?? null)) {
    const otherOwners = members.filter(
      (m) => m.userId !== userId && isOwnerRole(roles.get(m.userId) ?? null)
    );
    if (otherOwners.length === 0) {
      logger.warn("removeOrgMemberForDirectory: refusing to remove last Owner", {
        userId,
        organizationId,
      });
      return { removed: false, reason: "last_owner_protected" };
    }
  }

  await prisma.orgMember.delete({ where: { id: member.id } });
  const removeRole = await rbac.removeUserRole({ userId, organizationId });
  if (!removeRole.ok) {
    logger.warn("removeOrgMemberForDirectory: failed to remove RBAC role", {
      userId,
      organizationId,
      error: removeRole.error,
    });
  }

  // Post-delete cleanup is best-effort: the membership (the critical state) is
  // already gone, so any throw here must not propagate. If it did, the webhook
  // worker would retry, hit the `not_a_member` guard above, and skip the rest
  // of the cleanup entirely — leaving sessions or PATs behind. Swallowing lets
  // this single pass finish force-logout + PAT revocation.

  // Force logout everywhere.
  try {
    await prisma.user.update({ where: { id: userId }, data: { nextSessionEnd: new Date() } });
  } catch (error) {
    logger.warn("removeOrgMemberForDirectory: failed to force logout", {
      userId,
      organizationId,
      error,
    });
  }

  // Revoke PATs only if the user no longer belongs to ANY org — PATs are
  // user-global and used by the CLI across every org the user is in. Each
  // revoke is guarded so a concurrent self-revoke (which would throw) or one
  // bad token doesn't abort the rest.
  try {
    const remainingMemberships = await prisma.orgMember.count({ where: { userId } });
    if (remainingMemberships === 0) {
      const tokens = await getValidPersonalAccessTokens(userId);
      for (const token of tokens) {
        try {
          await revokePersonalAccessToken(token.id, userId);
        } catch (error) {
          logger.warn("removeOrgMemberForDirectory: failed to revoke PAT", {
            userId,
            tokenId: token.id,
            error,
          });
        }
      }
    }
  } catch (error) {
    logger.warn("removeOrgMemberForDirectory: PAT cleanup failed", {
      userId,
      organizationId,
      error,
    });
  }

  return { removed: true };
}
