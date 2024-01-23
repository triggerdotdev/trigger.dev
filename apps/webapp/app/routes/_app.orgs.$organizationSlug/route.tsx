import { Outlet, UIMatch } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { UpgradePrompt } from "~/components/billing/UpgradePrompt";
import { Breadcrumb, BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { PageNavigationIndicator } from "~/components/navigation/PageNavigationIndicator";
import { SideMenu } from "~/components/navigation/SideMenu";
import { featuresForRequest } from "~/features.server";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { useTypedMatchData, useTypedMatchesData } from "~/hooks/useTypedMatchData";
import { useUser } from "~/hooks/useUser";
import { BillingService } from "~/services/billing.server";
import { OrganizationsPresenter } from "~/presenters/OrganizationsPresenter.server";
import { getImpersonationId } from "~/services/impersonation.server";
import { requireUserId } from "~/services/session.server";
import { telemetry } from "~/services/telemetry.server";
import { Handle } from "~/utils/handle";
import { organizationPath } from "~/utils/pathBuilder";
import {
  commitCurrentProjectSession,
  getCurrentProjectId,
  setCurrentProjectId,
} from "~/services/currentProject.server";
import { prisma } from "~/db.server";
import { ProjectPresenter } from "~/presenters/ProjectPresenter.server";
import { logger } from "~/services/logger.server";

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

  //we need a project id in the session, we redirect if there isn't one
  const sessionProjectId = await getCurrentProjectId(request);
  if (!sessionProjectId) {
    logger.info("No project id in session", { userId, organizationSlug, projectParam });
    if (!projectParam) {
      logger.info("No project param in URL", { userId, organizationSlug, projectParam });
      const bestProject = await orgsPresenter.selectBestProject(organizationSlug, userId);
      const session = await setCurrentProjectId(bestProject.id, request);
      throw redirect(request.url, {
        headers: { "Set-Cookie": await commitCurrentProjectSession(session) },
      });
    }

    //use the project param to find the project
    const project = await prisma.project.findFirst({
      select: {
        id: true,
        slug: true,
      },
      where: {
        organization: {
          slug: organizationSlug,
        },
        slug: projectParam,
      },
    });

    if (!project) {
      throw new Response("Not found", { status: 404 });
    }

    const session = await setCurrentProjectId(project.id, request);
    throw redirect(request.url, {
      headers: { "Set-Cookie": await commitCurrentProjectSession(session) },
    });
  }

  const { organizations, organization } = await orgsPresenter.call({
    userId,
    request,
    organizationSlug,
  });

  telemetry.organization.identify({ organization });

  const projectPresenter = new ProjectPresenter();
  const project = await projectPresenter.call({ userId, id: sessionProjectId });
  if (!project) {
    logger.info("Not Found", { projectId: sessionProjectId, organization, project });
    throw new Response("Not Found", { status: 404 });
  }

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
          <div className="flex w-full items-center justify-between border-b border-ui-border">
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
