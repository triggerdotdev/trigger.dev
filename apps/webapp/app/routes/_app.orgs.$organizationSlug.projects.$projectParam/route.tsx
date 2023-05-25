import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import {
  ProjectSideMenu,
  SideMenuContainer,
} from "~/components/navigation/ProjectSideMenu";
import { ProjectPresenter } from "~/presenters/ProjectPresenter.server";
import { analytics } from "~/services/analytics.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = params;
  invariant(projectParam, "projectParam not found");

  const presenter = new ProjectPresenter();

  const project = await presenter.call({
    userId,
    slug: projectParam,
  });

  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  analytics.project.identify({ project });

  return typedjson({
    project,
  });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "projects",
  },
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
