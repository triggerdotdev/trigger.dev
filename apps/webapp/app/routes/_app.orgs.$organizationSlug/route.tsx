import type { ShouldRevalidateFunction } from "@remix-run/react";
import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs, Session } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { SideMenuContainer } from "~/components/navigation/ProjectSideMenu";
import { SideMenu } from "~/components/navigation/SideMenu";
import { useOrganization } from "~/hooks/useOrganizations";
import { useUser } from "~/hooks/useUser";
import { getOrganizations } from "~/models/organization.server";
import {
  commitCurrentProjectSession,
  getCurrentProjectId,
  setCurrentProjectId,
} from "~/services/currentProject.server";
import { requireUserId } from "~/services/session.server";
import { telemetry } from "~/services/telemetry.server";
import { organizationPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");

  const organizations = await getOrganizations({ userId });
  const organization = organizations.find((o) => o.slug === organizationSlug);
  if (!organization) {
    throw new Response("Not Found", { status: 404 });
  }

  telemetry.organization.identify({ organization });

  let projectId = await getCurrentProjectId(request);
  let session: Session | undefined;
  if (!projectId) {
    const project = organization.projects.sort((a, b) => b.jobCount - a.jobCount)[0];
    projectId = project.id;
    await setCurrentProjectId(projectId, request);
  }

  const project = organization.projects.find((p) => p.id === projectId);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  return typedjson(
    {
      organizations,
      organization,
      project,
    },
    {
      headers: session
        ? {
            "Set-Cookie": await commitCurrentProjectSession(session),
          }
        : undefined,
    }
  );
};

export default function Organization() {
  const { organization, project, organizations } = useTypedLoaderData<typeof loader>();
  const user = useUser();

  return (
    <>
      <SideMenuContainer>
        <SideMenu
          user={user}
          project={project}
          organization={organization}
          organizations={organizations}
        />
        <div className="flex-grow">
          <Outlet />
        </div>
      </SideMenuContainer>
    </>
  );
}

export function ErrorBoundary() {
  const org = useOrganization();
  return <RouteErrorDisplay button={{ title: org.title, to: organizationPath(org) }} />;
}

export const shouldRevalidate: ShouldRevalidateFunction = (options) => {
  if (options.formAction === "/resources/environment") {
    return false;
  }

  return true;
};
