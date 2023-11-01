import type { ShouldRevalidateFunction } from "@remix-run/react";
import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs, Session } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { z } from "zod";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { Breadcrumb } from "~/components/navigation/Breadcrumb";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { SideMenu, SideMenuContainer } from "~/components/navigation/SideMenu";
import { prisma } from "~/db.server";
import { useOptionalOrganization, useOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject, useProject } from "~/hooks/useProject";
import { useTypedMatchData } from "~/hooks/useTypedMatchData";
import { useUser } from "~/hooks/useUser";
import { OrganizationsPresenter } from "~/presenters/OrganizationsPresenter.server";
import {
  commitCurrentProjectSession,
  getCurrentProjectId,
  setCurrentProjectId,
} from "~/services/currentProject.server";
import { requireUserId } from "~/services/session.server";
import { telemetry } from "~/services/telemetry.server";
import { Handle } from "~/utils/handle";
import { organizationPath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  organizationSlug: z.string(),
  projectParam: z.string().optional(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ParamsSchema.parse(params);
  console.log("$orgslug page", { params, url: request.url });
  invariant(organizationSlug, "organizationSlug not found");

  const orgsPresenter = new OrganizationsPresenter();
  const organizations = await orgsPresenter.call({ userId });

  const organization = organizations.find((o) => o.slug === organizationSlug);
  if (!organization) {
    throw new Response("Not Found", { status: 404 });
  }

  telemetry.organization.identify({ organization });

  let projectId: string | undefined;
  if (projectParam) {
    const project = organization.projects.find((p) => p.slug === projectParam);
    projectId = project?.id;
  } else {
    projectId = await getCurrentProjectId(request);
  }

  const currentProject = organization.projects.find((p) => p.id === projectId);

  return typedjson({
    organizations,
    organization,
    currentProject,
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
  const { organization, currentProject, organizations } = useTypedLoaderData<typeof loader>();
  const user = useUser();

  //the side menu won't change projects when using the switcher unless we use the hook (on project pages)
  const project = useOptionalProject() ?? currentProject;

  return (
    <>
      <SideMenuContainer>
        <SideMenu
          user={user}
          project={project!}
          organization={organization}
          organizations={organizations}
        />
        <div className="grid h-full grid-rows-[2.75rem_auto]">
          <Breadcrumb />
          <Outlet />
        </div>
      </SideMenuContainer>
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
