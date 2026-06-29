import { Outlet, type ShouldRevalidateFunction, type UIMatch } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { prisma } from "~/db.server";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useTypedMatchesData } from "~/hooks/useTypedMatchData";
import { OrganizationsPresenter } from "~/presenters/OrganizationsPresenter.server";
import { RegionsPresenter, type Region } from "~/presenters/v3/RegionsPresenter.server";
import { getImpersonationId } from "~/services/impersonation.server";
import { getCachedUsage, getBillingLimit, getCurrentPlan } from "~/services/platform.v3.server";
import { rbac } from "~/services/rbac.server";
import { ssoController } from "~/services/sso.server";
import { canManageBilling } from "~/services/routeBuilders/permissions.server";
import { requireUser } from "~/services/session.server";
import { telemetry } from "~/services/telemetry.server";
import { organizationPath } from "~/utils/pathBuilder";
import { isEnvironmentPauseResumeFormSubmission } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.queues/route";
import { isBillingLimitSettingsFormSubmission } from "../_app.orgs.$organizationSlug.settings.billing-limits/billingLimitsRevalidation";

const ParamsSchema = z.object({
  organizationSlug: z.string(),
  projectParam: z.string().optional(),
  envParam: z.string().optional(),
});

export function useCurrentPlan(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof loader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });

  return data?.currentPlan;
}

/** Whether the optional RBAC plugin is installed (gates the Roles UI). */
export function useIsUsingRbacPlugin(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof loader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });

  return data?.isUsingRbacPlugin ?? false;
}

/** Whether the optional SSO plugin is installed (gates the SSO UI). */
export function useIsUsingSsoPlugin(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof loader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });

  return data?.isUsingSsoPlugin ?? false;
}

export const shouldRevalidate: ShouldRevalidateFunction = (params) => {
  const { currentParams, nextParams } = params;

  const current = ParamsSchema.safeParse(currentParams);
  const next = ParamsSchema.safeParse(nextParams);

  if (current.success && next.success) {
    if (current.data.organizationSlug !== next.data.organizationSlug) {
      return true;
    }
    if (current.data.projectParam !== next.data.projectParam) {
      return true;
    }
    if (current.data.envParam !== next.data.envParam) {
      return true;
    }
  }

  // Invalidate if the environment has been paused or resumed
  if (isEnvironmentPauseResumeFormSubmission(params.formMethod, params.formData)) {
    return true;
  }

  if (isBillingLimitSettingsFormSubmission(params.formMethod, params.formData)) {
    return true;
  }

  // This prevents revalidation when there are search params changes
  // IMPORTANT: If the loader function depends on search params, this should be updated
  return params.currentUrl.pathname !== params.nextUrl.pathname;
};

// IMPORTANT: Make sure to update shouldRevalidate if this loader depends on search params
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const impersonationId = await getImpersonationId(request);

  const { organizationSlug, projectParam, envParam } = ParamsSchema.parse(params);

  const orgsPresenter = new OrganizationsPresenter();
  const { organizations, organization, project, environment } = await orgsPresenter.call({
    user,
    request,
    organizationSlug,
    projectSlug: projectParam,
    environmentSlug: envParam,
  });

  telemetry.organization.identify({ organization });
  telemetry.project.identify({ project });

  //1st day of the month
  const firstDayOfMonth = new Date();
  firstDayOfMonth.setUTCDate(1);
  firstDayOfMonth.setUTCHours(0, 0, 0, 0);

  // Using the 1st day of next month means we get the usage for the current month
  // and the cache key for getCachedUsage is stable over the month
  const firstDayOfNextMonth = new Date();
  firstDayOfNextMonth.setUTCDate(1);
  firstDayOfNextMonth.setUTCHours(0, 0, 0, 0);
  firstDayOfNextMonth.setUTCMonth(firstDayOfNextMonth.getUTCMonth() + 1);

  const shouldLoadRegions = !!projectParam && !!environment && environment.type !== "DEVELOPMENT";

  const [
    sessionAuth,
    plan,
    usage,
    billingLimit,
    customDashboards,
    regions,
    isUsingRbacPlugin,
    isUsingSsoPlugin,
  ] = await Promise.all([
    rbac
      .authenticateSession(request, {
        userId: user.id,
        organizationId: organization.id,
      })
      .catch(() => ({ ok: false as const, reason: "unauthorized" as const })),
    getCurrentPlan(organization.id),
    getCachedUsage(organization.id, { from: firstDayOfMonth, to: firstDayOfNextMonth }),
    getBillingLimit(organization.id),
    prisma.metricsDashboard.findMany({
      where: { organizationId: organization.id },
      select: {
        friendlyId: true,
        title: true,
        layout: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    shouldLoadRegions
      ? new RegionsPresenter()
          .call({ userId: user.id, projectSlug: projectParam! })
          .then(({ regions }) => regions)
          .catch(() => [] as Region[])
      : Promise.resolve([] as Region[]),
    // Resolve which optional plugins are installed so the side menu can gate the
    // Roles (RBAC) and SSO items the same way the org settings side menu does.
    // Both calls are cheap and cached after the first resolution.
    rbac.isUsingPlugin().catch(() => false),
    ssoController.isUsingPlugin().catch(() => false),
  ]);
  const userCanManageBilling = sessionAuth.ok ? canManageBilling(sessionAuth.ability) : false;

  let hasExceededFreeTier = false;
  let usagePercentage = 0;
  if (plan?.v3Subscription && !plan.v3Subscription.isPaying && plan.v3Subscription.plan && usage) {
    hasExceededFreeTier = usage.cents > plan.v3Subscription.plan.limits.includedUsage;
    usagePercentage = usage.cents / plan.v3Subscription.plan.limits.includedUsage;
  }

  // Derive metric dashboard limit from plan, fallback to 3
  const metricDashboardsLimitValue = plan?.v3Subscription?.plan?.limits?.metricDashboards;
  const dashboardLimit =
    typeof metricDashboardsLimitValue === "number"
      ? metricDashboardsLimitValue
      : (metricDashboardsLimitValue?.number ?? 3);

  // Derive widget-per-dashboard limit from plan, fallback to 16
  const metricWidgetsLimitValue = plan?.v3Subscription?.plan?.limits?.metricWidgetsPerDashboard;
  const widgetLimitPerDashboard =
    typeof metricWidgetsLimitValue === "number"
      ? metricWidgetsLimitValue
      : (metricWidgetsLimitValue?.number ?? 16);

  // Compute widget counts per dashboard from layout JSON
  const customDashboardsWithWidgetCount = customDashboards.map((d) => {
    let widgetCount = 0;
    try {
      const layout = JSON.parse(String(d.layout)) as Record<string, unknown>;
      const widgets = layout.widgets;
      if (widgets && typeof widgets === "object") {
        widgetCount = Object.keys(widgets as Record<string, unknown>).length;
      }
    } catch {
      // ignore parse errors
    }
    return {
      friendlyId: d.friendlyId,
      title: d.title,
      widgetCount,
    };
  });

  return typedjson({
    organizations,
    organization,
    project,
    environment,
    regions,
    isImpersonating: !!impersonationId,
    currentPlan: { ...plan, v3Usage: { ...usage, hasExceededFreeTier, usagePercentage } },
    billingLimit,
    customDashboards: customDashboardsWithWidgetCount,
    dashboardLimits: {
      used: customDashboards.length,
      limit: dashboardLimit,
    },
    widgetLimitPerDashboard,
    canManageBilling: userCanManageBilling,
    isUsingRbacPlugin,
    isUsingSsoPlugin,
  });
};

export default function Organization() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const org = useOptionalOrganization();
  return org ? (
    <RouteErrorDisplay button={{ title: org.title, to: organizationPath(org) }} />
  ) : (
    <RouteErrorDisplay button={{ title: "Go to homepage", to: "/" }} />
  );
}
