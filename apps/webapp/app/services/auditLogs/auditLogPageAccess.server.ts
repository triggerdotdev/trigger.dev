import { prisma } from "~/db.server";
import { getImpersonationState } from "~/services/impersonation.server";
import { getUser } from "~/services/session.server";
import { auditLogPageOrganizationId } from "./auditLogsAccess.server";

/**
 * Who can see the audit log page and its filter options: both routes use this context and
 * authorization, so they can't drift apart.
 *
 * Scoped to membership: ability.can is not a tenant floor. An org without audit log access gets no
 * scope, so the routes answer 404 before the permission check, which would reveal the page with a
 * 403.
 */
export async function auditLogPageContext(params: { organizationSlug: string }, request: Request) {
  const user = await getUser(request);
  if (!user) return {};
  const { isImpersonating } = await getImpersonationState(request, user.id);
  const organizationId = await auditLogPageOrganizationId(prisma, params.organizationSlug, {
    id: user.id,
    admin: user.admin,
    isImpersonating,
  });
  return organizationId ? { organizationId } : {};
}

export const AUDIT_LOG_PAGE_AUTHORIZATION = {
  action: "manage",
  resource: { type: "audit-logs" },
  message: "With your current role, you can't view the audit log.",
} as const;
