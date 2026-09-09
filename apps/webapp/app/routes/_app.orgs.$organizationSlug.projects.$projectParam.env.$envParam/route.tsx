import {
  countChatsWithUnreadWork,
  readDashboardAgentWakeActivity,
  type DashboardAgentWakeActivity,
} from "@internal/dashboard-agent-db";
import { Outlet, useLoaderData } from "@remix-run/react";
import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { DashboardAgent } from "~/components/dashboard-agent/DashboardAgent";
import { prisma } from "~/db.server";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { updateCurrentProjectEnvironmentId } from "~/services/dashboardPreferences.server";
import { logger } from "~/services/logger.server";
import { hasAdminDisplayAccess, requireUser } from "~/services/session.server";
import { tenantContext } from "~/services/tenantContext.server";
import { selectAccessibleEnvironment } from "~/utils/environmentAccess";
import { EnvironmentParamSchema, v3ProjectPath } from "~/utils/pathBuilder";
import { getPromotedDashboardAgentPrompt } from "~/components/dashboard-agent/suggested-prompts/promotedPrompt.server";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";
import { canUseDashboardAgentWatches } from "~/v3/canUseDashboardAgentWatches.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await prisma.project.findFirst({
    where: {
      slug: projectParam,
      organization: {
        slug: organizationSlug,
        members: {
          some: {
            userId: user.id,
          },
        },
      },
      deletedAt: null,
    },
    select: {
      id: true,
      externalRef: true,
      organization: { select: { id: true, featureFlags: true } },
      environments: {
        where: { slug: envParam },
        select: {
          id: true,
          type: true,
          slug: true,
          orgMember: {
            select: {
              userId: true,
            },
          },
        },
      },
    },
  });

  if (!project) {
    logger.error("Project not found", { params, user });
    throw new Response("Project not Found", { status: 404, statusText: "Project not found" });
  }

  const environments = project.environments.filter((env) => env.slug === envParam);
  const environment = selectAccessibleEnvironment(environments, user.id);

  if (!environment) {
    return redirect(v3ProjectPath({ slug: organizationSlug }, { slug: projectParam }));
  }

  const environmentId = environment.id;
  const environmentType = environment.type;

  // userId is enriched higher up in `_app/route.tsx`; only stamp tenant fields here.
  tenantContext.enrich({
    orgId: project.organization.id,
    projectId: project.id,
    projectRef: project.externalRef,
    envId: environmentId,
    envType: environmentType,
  });

  await updateCurrentProjectEnvironmentId({ user: user, projectId: project.id, environmentId });

  // Resolve dashboard-agent access here (single source of truth: global env,
  // admins/impersonators, then the global/per-org feature flag, default off) so
  // the launcher button is hidden when it's not enabled. The org's featureFlags
  // came from the membership-checked project query above, so we pass them in to
  // avoid a second org lookup.
  // Display-only, so it respects the "view as user" toggle: while that's on we
  // hide the launcher an impersonated-into user wouldn't have.
  const showAdminUi = hasAdminDisplayAccess(user);
  const hasDashboardAgentAccess = await canAccessDashboardAgent({
    userId: user.id,
    isAdmin: showAdminUi && user.admin,
    isImpersonating: showAdminUi && user.isImpersonating,
    organizationSlug,
    orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
  });

  // Watches are a separate switch inside the agent, default off, so the panel renders
  // without any watch affordance until an org gets it.
  const dashboardAgentWatchEnabled = hasDashboardAgentAccess
    ? await canUseDashboardAgentWatches({
        userId: user.id,
        organizationSlug,
        orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
      })
    : false;

  const promotedDashboardAgentPrompt = hasDashboardAgentAccess
    ? await getPromotedDashboardAgentPrompt({
        orgFeatureFlags: (project.organization.featureFlags as Record<string, unknown>) ?? {},
      })
    : null;

  // One narrow read per page load, so the wake signal reaches a browser that has never opened
  // the panel — including one whose watch hasn't fired yet. The poll never asks for this.
  const noWakeActivity: DashboardAgentWakeActivity = { unreadWakes: 0, hasActiveWatches: false };
  let dashboardAgentActivity = noWakeActivity;
  let dashboardAgentUnreadWork = 0;
  if (hasDashboardAgentAccess) {
    try {
      [dashboardAgentActivity, dashboardAgentUnreadWork] = await Promise.all([
        // Not read at all with watches off, so a rolled-back flag leaves no wake dot behind.
        dashboardAgentWatchEnabled
          ? readDashboardAgentWakeActivity(dashboardAgentDb, {
              organizationId: project.organization.id,
              userId: user.id,
            })
          : noWakeActivity,
        countChatsWithUnreadWork(dashboardAgentDb, {
          organizationId: project.organization.id,
          userId: user.id,
        }),
      ]);
    } catch (error) {
      // The dashboard must load even when the agent's store doesn't answer.
      logger.error("Failed to read dashboard agent wake activity", { error });
    }
  }

  return {
    ...project,
    hasDashboardAgentAccess,
    dashboardAgentWatchEnabled,
    promotedDashboardAgentPrompt,
    dashboardAgentActivity,
    dashboardAgentUnreadWork,
  };
};

export default function Page() {
  const {
    hasDashboardAgentAccess,
    dashboardAgentWatchEnabled,
    promotedDashboardAgentPrompt,
    dashboardAgentActivity,
    dashboardAgentUnreadWork,
  } = useLoaderData<typeof loader>();
  return (
    <DashboardAgent
      hasAccess={hasDashboardAgentAccess}
      watchEnabled={dashboardAgentWatchEnabled}
      promotedPrompt={promotedDashboardAgentPrompt ?? undefined}
      initialUnreadWakes={dashboardAgentActivity.unreadWakes}
      initialUnreadWork={dashboardAgentUnreadWork}
      hasActiveWatches={dashboardAgentActivity.hasActiveWatches}
    >
      <Outlet />
    </DashboardAgent>
  );
}

// Caught here (inside the project SideMenu's Outlet) rather than at the project
// layout, so a permission denial or error on any env-scoped page renders in the
// content pane with the SideMenu intact. RouteErrorDisplay renders the
// permission panel for a 403 and the generic error otherwise.
export function ErrorBoundary() {
  return <RouteErrorDisplay />;
}
