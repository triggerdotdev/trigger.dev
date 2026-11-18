import type { AuditLogInput, AuditLogTarget } from "@trigger.dev/plugins";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import { logger } from "~/services/logger.server";
import { rbac } from "~/services/rbac.server";

/**
 * Who made a member change, when the request context can't say. Undefined lets the request context
 * supply it, e.g. the admin saving the SSO settings page.
 */
export type MemberAuditAttribution = Pick<AuditLogInput, "actor" | "source">;

/**
 * The directory sync worker acts with no user behind it, so its changes are attributed to the
 * system.
 */
export const DIRECTORY_SYNC_ATTRIBUTION: MemberAuditAttribution = {
  actor: { type: "system", id: null },
  source: "system",
};

/**
 * SSO just-in-time provisioning runs while the user signs in, before the request has a session, so
 * the context has no actor yet: the user signing in is the one who joined.
 */
export function ssoSignInAttribution(userId: string): MemberAuditAttribution {
  return { actor: { type: "user", id: userId }, source: "dashboard" };
}

/** Named by email: it's how the Team page shows members, and it outlives the membership. */
export function memberAuditTarget(
  member: { id: string; user: { email: string } } | null
): AuditLogTarget {
  return { type: "member", id: member?.id ?? null, name: member?.user.email ?? null };
}

/** Named by the invited email, as the Team page shows pending invites. */
export function inviteAuditTarget(invite: { id: string; email: string }): AuditLogTarget {
  return { type: "invite", id: invite.id, name: invite.email };
}

/**
 * The name of a role, for an audit event. Null when the RBAC plugin doesn't list it or the lookup
 * fails: auditing never fails the change it describes.
 */
export async function auditRoleName(
  organizationId: string,
  roleId: string
): Promise<string | null> {
  try {
    const roles = await rbac.allRoles(organizationId);
    return roles.find((role) => role.id === roleId)?.name ?? null;
  } catch (error) {
    logger.warn("auditRoleName: failed to look up the role name", {
      organizationId,
      roleId,
      error,
    });
    return null;
  }
}

/**
 * Records the event `build` returns, or nothing for null, without making the change wait for the
 * reads that describe it. Does nothing, not even the reads, while recording is off. Never throws:
 * a failure is logged. `auditLogs.flush` waits for it.
 */
export function recordMemberAuditEventInBackground(
  build: () => Promise<AuditLogInput | null>,
  details: { action: AuditLogInput["action"]; organizationId: string }
): void {
  auditLogs.recordLater(async () => {
    try {
      return await build();
    } catch (error) {
      logger.error("Member audit: failed to describe the change", { ...details, error });
      return null;
    }
  });
}
