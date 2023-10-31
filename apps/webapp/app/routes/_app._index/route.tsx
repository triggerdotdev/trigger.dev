import { LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { OrganizationsPresenter } from "~/presenters/OrganizationsPresenter.server";
import { getCurrentProjectId } from "~/services/currentProject.server";
import { requireUserId } from "~/services/session.server";
import { projectPath } from "~/utils/pathBuilder";

//this loader chooses the best project to redirect you to, ideally based on the cookie
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);

  const orgsPresenter = new OrganizationsPresenter();
  const organizations = await orgsPresenter.call({ userId });

  let projectId = await getCurrentProjectId(request);
  if (projectId) {
    const organization = organizations.find((o) => o.projects.some((p) => p.id === projectId));
    const project = organization?.projects.find((p) => p.id === projectId);
    if (organization && project) {
      return redirect(projectPath(organization, project));
    }
  }

  const project = organizations
    .flatMap((o) => o.projects)
    .sort((a, b) => b.jobCount - a.jobCount)[0];
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  const organization = organizations.find((o) => o.projects.some((p) => p.id === project.id));
  if (!organization) {
    throw new Response("Not Found", { status: 404 });
  }

  return redirect(projectPath(organization, project));
};
