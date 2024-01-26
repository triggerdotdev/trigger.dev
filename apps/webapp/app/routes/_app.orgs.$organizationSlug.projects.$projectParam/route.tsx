import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { organizationMatchId, useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useTypedMatchData } from "~/hooks/useTypedMatchData";
import { ProjectPresenter } from "~/presenters/ProjectPresenter.server";
import { commitCurrentProjectSession, setCurrentProjectId } from "~/services/currentProject.server";
import { requireUserId } from "~/services/session.server";
import { telemetry } from "~/services/telemetry.server";
import { Handle } from "~/utils/handle";
import { projectPath } from "~/utils/pathBuilder";
import { loader as orgLoader } from "../_app.orgs.$organizationSlug/route";

export const handle: Handle = {
  breadcrumb: (match, matches) => {
    const orgMatch = matches.find((m) => m.id === organizationMatchId);
    const data = useTypedMatchData<typeof orgLoader>(orgMatch);
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
