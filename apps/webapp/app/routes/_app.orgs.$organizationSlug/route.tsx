import { Outlet, ShouldRevalidateFunction, UIMatch } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { UpgradePrompt } from "~/components/billing/UpgradePrompt";
import { Breadcrumb, BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { PageNavigationIndicator } from "~/components/navigation/PageNavigationIndicator";
import { SideMenu } from "~/components/navigation/SideMenu";
import { featuresForRequest } from "~/features.server";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useTypedMatchData, useTypedMatchesData } from "~/hooks/useTypedMatchData";
import { useUser } from "~/hooks/useUser";
import { OrganizationsPresenter } from "~/presenters/OrganizationsPresenter.server";
import { BillingService } from "~/services/billing.server";
import { getImpersonationId } from "~/services/impersonation.server";
import { requireUserId } from "~/services/session.server";
import { telemetry } from "~/services/telemetry.server";
import { Handle } from "~/utils/handle";
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

  const { isManagedCloud } = featuresForRequest(request);
  const billingPresenter = new BillingService(isManagedCloud);
  const currentPlan = await billingPresenter.currentPlan(organization.id);

  return typedjson({
    organizations,
    organization,
    project,
    isImpersonating: !!impersonationId,
    currentPlan,
  });
};

export const handle: Handle = {
  breadcrumb: (match) => {
    const data = useTypedMatchData<typeof loader>(match);
    return (
      <BreadcrumbLink to={match.pathname} title={data?.organization.title ?? "Organization"} />
    );
  },
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
        <div className="grid grid-rows-[2.25rem_1fr] overflow-hidden">
          <div className="flex w-full items-center justify-between border-b border-grid-bright">
            <Breadcrumb />
            <div className="flex h-full items-center gap-4">
              <PageNavigationIndicator className="mr-2" />
              <UpgradePrompt organization={organization} />
            </div>
          </div>
          <Outlet />
        </div>
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
