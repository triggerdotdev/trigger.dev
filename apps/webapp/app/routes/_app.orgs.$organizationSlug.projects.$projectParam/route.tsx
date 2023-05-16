import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import {
  ProjectSideMenu,
  SideMenuContainer,
} from "~/components/navigation/ProjectSideMenu";
import { ProjectsMenu } from "~/components/navigation/ProjectsMenu";
import { getProjectFromSlug } from "~/models/project.server";
import { analytics } from "~/services/analytics.server";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = params;
  invariant(projectParam, "projectParam not found");

  const project = await getProjectFromSlug({
    userId,
    id: projectParam,
  });

  if (project === null) {
    throw new Response("Not Found", { status: 404 });
  }

  analytics.project.identify({ project });

  return typedjson({
    project,
  });
};

export const handle = {
  useBreadcrumbElement: () => <ProjectsMenu />,
};

export default function Project() {
  return (
    <>
      <SideMenuContainer>
        <ProjectSideMenu />
        <Outlet />
      </SideMenuContainer>
    </>
  );
}
