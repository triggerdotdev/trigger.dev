import { tryCatch } from "@trigger.dev/core/utils";
import type { RoleAssignmentResult } from "@trigger.dev/plugins";
import { $transaction, Prisma, prisma } from "~/db.server";
import { deleteOrgMember, prepareMemberRemovalKeys } from "./deleteOrgMember.server";
import { findOrCreateDirectoryUser } from "./directoryUser.server";
import {
  auditRoleName,
  type MemberAuditAttribution,
  memberAuditTarget,
  recordMemberAuditEventInBackground,
} from "./memberAudit.server";
import type { MembershipSource, OrgMemberJoinMethod } from "~/models/member.server";
import { isOrganizationJoinAllowed } from "~/services/accessPolicy.server";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import {
  recordMemberRemovalCredentials,
  SYSTEM_ACTOR,
} from "~/services/credentialFingerprints.server";
import { enqueueAttioMemberSync } from "~/services/attio.server";
import { logger } from "~/services/logger.server";
import { enqueueMemberDevelopmentEnvironments } from "~/services/memberDevEnvironments.server";
import { rbac } from "~/services/rbac.server";
import {
  getValidPersonalAccessTokens,
  revokePersonalAccessToken,
} from "~/services/personalAccessToken.server";

async function deleteMembership(memberId: string, organizationId: string) {
  const member = { id: memberId, organizationId };
  // The new development keys' fingerprints are saved first: a failed save fails the removal.
  const newKeys = await prepareMemberRemovalKeys(prisma, member, SYSTEM_ACTOR);
  const result = await $transaction(prisma, "delete org member", (tx) =>
    deleteOrgMember(tx, member, newKeys)
  );
  if (!result) {
    throw new Error("Failed to delete organization member");
  }
  recordMemberRemovalCredentials(result.credentials, SYSTEM_ACTOR);
}

/** The member a role change event names: their membership and email. */
function findAuditMember(userId: string, organizationId: string) {
  return prisma.orgMember.findFirst({
    where: { userId, organizationId },
    select: { id: true, user: { select: { email: true } } },
  });
}

/**
 * Whether the user was still a member when their role was written, read right after the write and
 * before the change returns, so a removal after the change can't drop its event. The RBAC plugin
 * writes a role for a user who isn't a member, so a removal between the member read and the write
 * would otherwise record a change to a membership that no longer exists.
 *
 * Best-effort: if this read fails, the change is recorded anyway, since the write succeeded and the
 * member read before it saw a member.
 *
 * TODO: https://linear.app/triggerdotdev/issue/TRI-16185 makes `setUserRole` refuse a non-member in
 * its own transaction. Then the write's result (`result.ok`) replaces this inline read, and the
 * member lookup after a failed member read can go too.
 */
async function wasMemberAtWrite(userId: string, organizationId: string): Promise<boolean> {
  const [error, member] = await tryCatch(
    prisma.orgMember.findFirst({ where: { userId, organizationId }, select: { id: true } })
  );
  if (error) {
    logger.warn("setOrgMemberRole: failed to check the member after the change", {
      userId,
      organizationId,
      error,
    });
    return true;
  }
  return member !== null;
}

/**
 * Sets a member's org-wide role and records `member.role_changed`. The RBAC plugin commits the
 * change in its own transaction and retries it on serialization failures, so the event is recorded
 * after the call returns: once per change however many attempts it took, and never for a change
 * that failed. Setting the role a member already has, or a role for a user who isn't a member,
 * records nothing. While recording is off, it reads nothing for the event.
 *
 * "after" is the role this call wrote. "before" is read before the write, outside the plugin's
 * transaction, so it is best-effort: a concurrent change between the read and the write can make it
 * stale, or skip the event when the stale role equals the new one. The proper fix (the plugin
 * returning the previous role from its transaction) is
 * https://linear.app/triggerdotdev/issue/TRI-16184. The member is read before the write too, so the
 * event can name them after a later removal. Whether they were still a member at the write is
 * checked right after it, before this returns (see `wasMemberAtWrite`). Auditing never blocks the
 * role change: a failed read is logged and the change goes ahead.
 *
 * `attribution` is for callers with no user behind them, such as the directory sync worker.
 */
export async function setOrgMemberRole(
  params: { userId: string; organizationId: string; roleId: string },
  attribution?: MemberAuditAttribution
): Promise<RoleAssignmentResult> {
  const result = await writeOrgMemberRole(params, attribution);
  if (result.ok) {
    await enqueueAttioMemberSync({ organizationId: params.organizationId, userId: params.userId });
  }
  return result;
}

async function writeOrgMemberRole(
  params: { userId: string; organizationId: string; roleId: string },
  attribution?: MemberAuditAttribution
): Promise<RoleAssignmentResult> {
  const { userId, organizationId, roleId } = params;

  if (!auditLogs.isRecordingEnabled()) {
    return rbac.setUserRole({ userId, organizationId, roleId });
  }

  // Both reads run together, so the change waits for one round trip, not two. The role is read even
  // for a user who turns out not to be a member, where it goes unused.
  const [[memberReadError, memberBeforeWrite], [roleBeforeError, roleBefore]] = await Promise.all([
    // Read before the write, so a later removal can't leave the event with nobody to name. If this
    // read fails, the member is looked up after the write instead.
    tryCatch(findAuditMember(userId, organizationId)),
    // If this read fails, the change is recorded with an unknown "before".
    tryCatch(rbac.getUserRole({ userId, organizationId })),
  ]);
  if (memberReadError) {
    logger.warn("setOrgMemberRole: failed to read the member before the change", {
      userId,
      organizationId,
      error: memberReadError,
    });
  } else if (!memberBeforeWrite) {
    // Not a member: the plugin still writes the role, but there's no membership change to record.
    return rbac.setUserRole({ userId, organizationId, roleId });
  }

  if (roleBeforeError) {
    logger.warn("setOrgMemberRole: failed to read the role before the change", {
      userId,
      organizationId,
      error: roleBeforeError,
    });
  }

  const result = await rbac.setUserRole({ userId, organizationId, roleId });
  if (!result.ok || (!roleBeforeError && roleBefore?.id === roleId)) {
    return result;
  }

  // Removed between the member read and the write: there's no membership change to record.
  if (memberBeforeWrite && !(await wasMemberAtWrite(userId, organizationId))) {
    return result;
  }

  // The role has changed. The reads below run after this returns, so they never delay the change;
  // a missing role name is recorded as null.
  recordMemberAuditEventInBackground(
    async () => {
      let member = memberBeforeWrite;
      if (!member) {
        // The read before the write failed. Nobody now: there's no membership to record.
        member = await findAuditMember(userId, organizationId);
        if (!member) return null;
      }
      return {
        category: "members",
        action: "member.role_changed",
        organizationId,
        target: memberAuditTarget(member),
        changes: {
          role: {
            before: roleBefore?.name ?? null,
            after: await auditRoleName(organizationId, roleId),
          },
        },
        ...attribution,
      };
    },
    { action: "member.role_changed", organizationId }
  );
  return result;
}

export type EnsureOrgMemberParams = {
  userId: string;
  organizationId: string;
  // null = use the seeded MEMBER role from the existing enum. A non-null
  // value is an RBAC role id; when an RBAC plugin is installed it gets
  // attached after the OrgMember row is created.
  roleId: string | null;
  source: MembershipSource;
};

export class OrganizationNotAcceptingMembersError extends Error {
  constructor() {
    super("This organization is not accepting new members.");
    this.name = "OrganizationNotAcceptingMembersError";
  }
}

export type EnsureOrgMemberResult = {
  created: boolean;
  orgMemberId: string;
  /** False when provisioning could not be queued; the membership is still valid. */
  devEnvironmentsQueued: boolean;
};

// Completes a JIT role assignment for an ALREADY-existing membership whose
// RBAC role never got applied. This is a no-op when a role is already
// assigned, so it can never demote a deliberately-set role — it only fills
// in the gap left by an interrupted provision (see `ensureOrgMember`). Always
// best-effort: a valid membership already exists, so a failure here is logged
// and swallowed rather than thrown.
// Not audited: it repairs a half-provisioned row rather than changing anyone's access.
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
  if (result.ok) {
    await enqueueAttioMemberSync({ organizationId, userId });
  } else {
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
//
// A new membership records `member.added` once its role is applied; an existing one, a lost
// create race or a rolled-back create records nothing. `attribution` is for callers the request
// context can't describe: the directory sync worker and SSO sign-in.
export async function ensureOrgMember(
  params: EnsureOrgMemberParams,
  attribution?: MemberAuditAttribution
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
    const { enqueued } = await enqueueMemberDevelopmentEnvironments({
      userId,
      organizationId,
      source,
    });
    return { created: false, orgMemberId: existing.id, devEnvironmentsQueued: enqueued };
  }

  if (!(await isOrganizationJoinAllowed({ organizationId }))) {
    throw new OrganizationNotAcceptingMembersError();
  }

  // Two concurrent JIT/invite flows can both miss the findFirst above and
  // race to create the same (userId, organizationId) row; the unique
  // constraint makes one lose with P2002. Treat that as the idempotent
  // "already a member" case rather than letting it break sign-in.
  let member: { id: string; user: { email: string } };
  try {
    member = await prisma.orgMember.create({
      data: {
        userId,
        organizationId,
        role: "MEMBER",
        joinMethod: source satisfies OrgMemberJoinMethod,
      },
      select: { id: true, user: { select: { email: true } } },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existingAfterConflict = await prisma.orgMember.findFirst({
        where: { userId, organizationId },
        select: { id: true },
      });
      if (existingAfterConflict) {
        const { enqueued } = await enqueueMemberDevelopmentEnvironments({
          userId,
          organizationId,
          source,
        });
        return {
          created: false,
          orgMemberId: existingAfterConflict.id,
          devEnvironmentsQueued: enqueued,
        };
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
      await deleteMembership(member.id, organizationId);
      throw new Error(`ensureOrgMember: failed to apply role ${roleId}: ${result.error}`);
    }
  }

  const addedMember = member;
  if (roleId !== null) {
    recordMemberAuditEventInBackground(
      async () => ({
        category: "members",
        action: "member.added",
        organizationId,
        target: memberAuditTarget(addedMember),
        changes: { role: await auditRoleName(organizationId, roleId) },
        ...attribution,
      }),
      { action: "member.added", organizationId }
    );
  } else {
    auditLogs.record({
      category: "members",
      action: "member.added",
      organizationId,
      target: memberAuditTarget(member),
      // Null role: the legacy MEMBER placeholder, whose effective role is the RBAC plugin's call.
      changes: null,
      ...attribution,
    });
  }

  // Only once the role has applied: a failed role rolls the membership back above.
  await enqueueAttioMemberSync({ organizationId, userId });

  const { enqueued } = await enqueueMemberDevelopmentEnvironments({
    userId,
    organizationId,
    source,
  });

  return { created: true, orgMemberId: member.id, devEnvironmentsQueued: enqueued };
}

// Directory Sync can provision a user before they have ever logged in, so
// the User row may not exist yet.
export async function ensureUserForDirectory(params: {
  email: string;
  firstName: string | null;
  lastName: string | null;
}): Promise<{ userId: string }> {
  return findOrCreateDirectoryUser(prisma, params);
}

// Whether the user holds the Owner system role in this org. Owner is the one
// role Directory Sync must never strip (it can't be auto-granted and is the
// org's recovery anchor), so deprovision is guarded against removing the last
// one. Identified by the RBAC system role; OSS-safe (no plugin → not Owner).
export function isOwnerRole(role: { name: string; isSystem: boolean } | null): boolean {
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
export async function removeOrgMemberForDirectory(
  params: {
    userId: string;
    organizationId: string;
  },
  attribution?: MemberAuditAttribution
): Promise<RemoveOrgMemberForDirectoryResult> {
  const { userId, organizationId } = params;

  const member = await prisma.orgMember.findFirst({
    where: { userId, organizationId },
    select: { id: true, user: { select: { email: true } } },
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

  await deleteMembership(member.id, organizationId);
  await enqueueAttioMemberSync({ organizationId, userId });
  auditLogs.record({
    category: "members",
    action: "member.removed",
    organizationId,
    target: memberAuditTarget(member),
    ...attribution,
  });
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
          await revokePersonalAccessToken(token.id, userId, {
            reason: "member_removed",
            revokedBy: SYSTEM_ACTOR,
          });
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
