import type { OrgMemberRole } from "@trigger.dev/database";
import { rbac } from "~/services/rbac.server";
import { isAtOrBelow } from "~/utils/inviteRoleLadder";

type SystemRoles = Awaited<ReturnType<typeof rbac.systemRoles>>;

export const INVITE_ROLE_ABOVE_INVITER = "You can only invite members at or below your own role";

/**
 * Whether the user may send, or resend, an invite with this role: it must be at or below their own
 * role, as it is now. An invite without a role joins on the legacy mapping of its member role
 * (MEMBER to Admin, ADMIN to Owner), so it counts as that role. Always allowed without the RBAC
 * plugin, which has no roles to compare. Pass `systemRoles` when the caller already loaded them.
 */
export async function canInviteWithRole({
  userId,
  organizationId,
  rbacRoleId,
  legacyRole,
  systemRoles: loadedSystemRoles,
}: {
  userId: string;
  organizationId: string;
  rbacRoleId: string | null;
  legacyRole: OrgMemberRole;
  systemRoles?: SystemRoles;
}): Promise<boolean> {
  const systemRoles =
    loadedSystemRoles !== undefined ? loadedSystemRoles : await rbac.systemRoles(organizationId);
  if (!systemRoles) {
    return true;
  }
  const invitedRoleId =
    rbacRoleId ??
    systemRoles.find((role) => role.name === (legacyRole === "ADMIN" ? "Owner" : "Admin"))?.id;
  if (!invitedRoleId) {
    return false;
  }
  const inviterRole = await rbac.getUserRole({ userId, organizationId });
  return isAtOrBelow(systemRoles, inviterRole?.id ?? null, invitedRoleId);
}
