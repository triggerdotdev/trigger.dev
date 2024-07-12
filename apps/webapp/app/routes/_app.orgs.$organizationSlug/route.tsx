import { Outlet, type ShouldRevalidateFunction, type UIMatch } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { MainBody } from "~/components/layout/AppLayout";
import { SideMenu } from "~/components/navigation/SideMenu";
import { featuresForRequest } from "~/features.server";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useTypedMatchesData } from "~/hooks/useTypedMatchData";
import { useUser } from "~/hooks/useUser";
import { OrganizationsPresenter } from "~/presenters/OrganizationsPresenter.server";
import { getImpersonationId } from "~/services/impersonation.server";
import { getCurrentPlan, getUsage } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import { telemetry } from "~/services/telemetry.server";
import { organizationPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  organizationSlug: z.string(),
  projectParam: z.string().optional(),
});

export function useCurrentPlan(matches?: UIMatch[]) {
  const data = useTypedMatchesData<typeof loader>({
    id: "routes/_app.orgs.$organizationSlug",
    matches,
  });

  return data?.currentPlan;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const impersonationId = await getImpersonationId(request);

  const { organizationSlug, projectParam } = ParamsSchema.parse(params);

  const orgsPresenter = new OrganizationsPresenter();
  const { organizations, organization, project } = await orgsPresenter.call({
    userId,
    request,
    organizationSlug,
    projectSlug: projectParam,
  });

  telemetry.organization.identify({ organization });
  telemetry.project.identify({ project });

  //1st day of the month
  const firstDayOfMonth = new Date();
  firstDayOfMonth.setUTCDate(1);
  firstDayOfMonth.setUTCHours(0, 0, 0, 0);
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getDate() + 1);
  const [plan, usage] = await Promise.all([
    getCurrentPlan(organization.id),
    getUsage(organization.id, { from: firstDayOfMonth, to: tomorrow }),
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
    isImpersonating: !!impersonationId,
    currentPlan: { ...plan, v3Usage: { ...usage, hasExceededFreeTier, usagePercentage } },
  });
};

export default function Organization() {
  const { organization, project, organizations, isImpersonating } =
    useTypedLoaderData<typeof loader>();
  const user = useUser();

  return (
    <>
      <div className="grid grid-cols-[14rem_1fr] overflow-hidden">
        <SideMenu
          user={{ ...user, isImpersonating }}
          project={project}
          organization={organization}
          organizations={organizations}
        />
        <MainBody>
          <Outlet />
        </MainBody>
      </div>
    </>
  );
}

export function ErrorBoundary() {
  const org = useOptionalOrganization();
  return org ? (
    <RouteErrorDisplay button={{ title: org.title, to: organizationPath(org) }} />
  ) : (
    <RouteErrorDisplay button={{ title: "Home", to: "/" }} />
  );
}

export const shouldRevalidate: ShouldRevalidateFunction = ({
  defaultShouldRevalidate,
  currentParams,
  nextParams,
}) => {
  const current = ParamsSchema.safeParse(currentParams);
  const next = ParamsSchema.safeParse(nextParams);

  if (current.success && next.success) {
    if (current.data.organizationSlug !== next.data.organizationSlug) {
      return true;
    }
    if (current.data.projectParam !== next.data.projectParam) {
      return true;
    }
  }

  return defaultShouldRevalidate;
};
