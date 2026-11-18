import { $replica, type PrismaClientOrTransaction } from "~/db.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

/** The permission that lets a role view the audit log. */
export const AUDIT_LOG_PERMISSION = "manage:audit-logs";

/**
 * Whether the org itself can see its audit log: the org's `hasAuditLogsAccess` override, then the
 * global flag, then off. No admin bypass: for paths that act as the org, like the audit events API,
 * and for what the Roles page lists.
 */
export async function organizationHasAuditLogsAccess(
  organizationId: string,
  client: PrismaClientOrTransaction = $replica
): Promise<boolean> {
  const org = await client.organization.findFirst({
    where: { id: organizationId },
    select: { featureFlags: true },
  });
  return makeFlag(client)({
    key: FEATURE_FLAG.hasAuditLogsAccess,
    defaultValue: false,
    overrides: (org?.featureFlags as Record<string, unknown>) ?? {},
  });
}

/**
 * Whether a dashboard user sees the org's audit log: {@link organizationHasAuditLogsAccess}, and
 * admins and impersonators always do.
 */
export async function hasAuditLogsAccess(
  user: { admin: boolean; isImpersonating: boolean },
  organizationId: string,
  client: PrismaClientOrTransaction = $replica
): Promise<boolean> {
  if (user.admin || user.isImpersonating) return true;
  return organizationHasAuditLogsAccess(organizationId, client);
}

/**
 * The permissions to list for an org: without audit log access, `manage:audit-logs` is left out, so the
 * Roles page doesn't offer a permission that does nothing yet. Roles keep the rule itself.
 */
export function permissionsShownToOrg<T extends { name: string }>(
  permissions: T[],
  auditLogsAccess: boolean
): T[] {
  if (auditLogsAccess) return permissions;
  return permissions.filter((permission) => permission.name !== AUDIT_LOG_PERMISSION);
}
