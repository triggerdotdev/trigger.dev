import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { Breadcrumb, BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { SideMenu } from "~/components/navigation/SideMenu";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { useTypedMatchData } from "~/hooks/useTypedMatchData";
import { useUser } from "~/hooks/useUser";
import { OrganizationsPresenter } from "~/presenters/OrganizationsPresenter.server";
import { getCurrentProjectId } from "~/services/currentProject.server";
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

    if (!project) {
      throw new Response("Not Found", { status: 404 });
    }

    projectId = project.id;
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
      <div className="grid grid-cols-[14rem_auto]">
        <SideMenu
          user={user}
          project={project!}
          organization={organization}
          organizations={organizations}
        />
        <div className="grid grid-rows-[2.25rem_auto] ">
          <Breadcrumb />
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
