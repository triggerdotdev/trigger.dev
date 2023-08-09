import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { ProjectSideMenu, SideMenuContainer } from "~/components/navigation/ProjectSideMenu";
import { ProjectsMenu } from "~/components/navigation/ProjectsMenu";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { ProjectPresenter } from "~/presenters/ProjectPresenter.server";
import { telemetry } from "~/services/telemetry.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import { projectPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = params;
  invariant(projectParam, "projectParam not found");

  try {
    const presenter = new ProjectPresenter();

    const project = await presenter.call({
      userId,
      slug: projectParam,
    });

    if (!project) {
      throw new Response("Not Found", {
        status: 404,
        statusText: `Project ${projectParam} not found in your Organization.`,
      });
    }

    telemetry.project.identify({ project });

    return typedjson({
      project,
    });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export const handle: Handle = {
  breadcrumb: (_match, matches) => <ProjectsMenu matches={matches} />,
};

export default function Project() {
  return (
    <>
      <SideMenuContainer>
        <ProjectSideMenu />
        <div className="flex-grow">
          <Outlet />
        </div>
      </SideMenuContainer>
    </>
  );
}

export function ErrorBoundary() {
  const org = useOrganization();
  const project = useProject();
  return <RouteErrorDisplay button={{ title: project.name, to: projectPath(org, project) }} />;
}
