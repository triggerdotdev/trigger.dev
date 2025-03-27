import { Outlet, type ShouldRevalidateFunction, type UIMatch } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useTypedMatchesData } from "~/hooks/useTypedMatchData";
import { OrganizationsPresenter } from "~/presenters/OrganizationsPresenter.server";
import { getImpersonationId } from "~/services/impersonation.server";
import { getCachedUsage, getCurrentPlan } from "~/services/platform.v3.server";
import { requireUser } from "~/services/session.server";
import { telemetry } from "~/services/telemetry.server";
import { organizationPath } from "~/utils/pathBuilder";
import { isEnvironmentPauseResumeFormSubmission } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.queues/route";
import { logger } from "~/services/logger.server";

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
  firstDayOfNextMonth.setUTCMonth(firstDayOfNextMonth.getUTCMonth() + 1);
  firstDayOfNextMonth.setUTCDate(1);
  firstDayOfNextMonth.setUTCHours(0, 0, 0, 0);

  const [plan, usage] = await Promise.all([
    getCurrentPlan(organization.id),
    getCachedUsage(organization.id, { from: firstDayOfMonth, to: firstDayOfNextMonth }),
  ]);

  let hasExceededFreeTier = false;
  let usagePercentage = 0;
  if (plan?.v3Subscription && !plan.v3Subscription.isPaying && plan.v3Subscription.plan && usage) {
    hasExceededFreeTier = usage.cents > plan.v3Subscription.plan.limits.includedUsage;
    usagePercentage = usage.cents / plan.v3Subscription.plan.limits.includedUsage;
  }

  return typedjson({
    organizations,
    organization,
    project,
    environment,
    isImpersonating: !!impersonationId,
    currentPlan: { ...plan, v3Usage: { ...usage, hasExceededFreeTier, usagePercentage } },
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
