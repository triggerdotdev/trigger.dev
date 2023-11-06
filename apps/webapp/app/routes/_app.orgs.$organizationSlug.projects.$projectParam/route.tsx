import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useTypedMatchData } from "~/hooks/useTypedMatchData";
import { ProjectPresenter } from "~/presenters/ProjectPresenter.server";
import { commitCurrentProjectSession, setCurrentProjectId } from "~/services/currentProject.server";
import { requireUserId } from "~/services/session.server";
import { telemetry } from "~/services/telemetry.server";
import { Handle } from "~/utils/handle";
import { projectPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
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

    const session = await setCurrentProjectId(project.id, request);

    return typedjson(
      {
        project,
      },
      {
        headers: { "Set-Cookie": await commitCurrentProjectSession(session) },
      }
    );
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
  breadcrumb: (match) => {
    const data = useTypedMatchData<typeof loader>(match);
    return <BreadcrumbLink to={match.pathname} title={data?.project.name ?? "Project"} />;
  },
  scripts: (match) => [
    {
      src: "https://cdn.jsdelivr.net/npm/canvas-confetti@1.5.1/dist/confetti.browser.min.js",
      crossOrigin: "anonymous",
    },
  ],
};

export default function Project() {
  return (
    <>
      <Outlet />
    </>
  );
}

export function ErrorBoundary() {
  const org = useOrganization();
  const project = useProject();
  return <RouteErrorDisplay button={{ title: project.name, to: projectPath(org, project) }} />;
}
