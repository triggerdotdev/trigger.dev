import { getChatOrganizationId } from "@internal/dashboard-agent-db";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { authIncludeWithParent, toAuthenticated } from "~/models/runtimeEnvironment.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";

/**
 * Authorize a user against an environment by id: membership, live project and org, and agent
 * access. The id lookup is unscoped and proves nothing; the scoped read below is the gate.
 */
export async function authorizeAgentEnvironmentById(params: {
  userId: string;
  environmentId: string;
}): Promise<AuthenticatedEnvironment | null> {
  const scope = await $replica.runtimeEnvironment.findFirst({
    where: { id: params.environmentId },
    select: { organizationId: true, projectId: true },
  });
  if (!scope) return null;

  // The primary, not the replica: replica lag would extend access the user has lost.
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: params.environmentId,
      projectId: scope.projectId,
      organizationId: scope.organizationId,
      archivedAt: null,
      project: { deletedAt: null },
      organization: { deletedAt: null, members: { some: { userId: params.userId } } },
      OR: [
        { type: { in: ["PREVIEW", "STAGING", "PRODUCTION"] } },
        // Dev environments are per-member: only their owner may read them.
        { type: "DEVELOPMENT", orgMember: { userId: params.userId } },
      ],
    },
    include: authIncludeWithParent,
  });
  if (!environment) return null;

  // The gate only reads `isAdmin` while the admin preview is on, so the read is skipped otherwise.
  let isAdmin = false;
  if (env.DASHBOARD_AGENT_ADMIN_PREVIEW === "1") {
    const user = await prisma.user.findFirst({
      where: { id: params.userId },
      select: { admin: true },
    });
    if (!user) return null;
    isAdmin = user.admin;
  }

  const allowed = await canAccessDashboardAgent({
    userId: params.userId,
    isAdmin,
    isImpersonating: false,
    organizationSlug: environment.organization.slug,
    orgFeatureFlags: environment.organization.featureFlags as Record<string, unknown> | null,
  });
  return allowed ? toAuthenticated(environment) : null;
}

export function resolveChatOrganizationId(params: {
  chatId: string;
  userId: string;
}): Promise<string | null> {
  return getChatOrganizationId(dashboardAgentDb, params);
}
