import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { ENV_PAGE_SEGMENTS } from "~/components/navigation/favoritePages";
import { prisma } from "~/db.server";
import { SelectBestEnvironmentPresenter } from "~/presenters/SelectBestEnvironmentPresenter.server";
import { requireUser } from "~/services/session.server";
import { newOrganizationPath, newProjectPath, v3EnvironmentPath } from "~/utils/pathBuilder";

/**
 * Stable links that don't name an org, project or environment: /deeplink/apikeys redirects to
 * /orgs/{org}/projects/{project}/env/{env}/apikeys for whoever is signed in. Only pages the
 * dashboard knows about are followed, so an unrecognised path can never become the redirect
 * target — it lands on the resolved environment instead.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const segments = (params["*"] ?? "").split("/").filter(Boolean);
  //deeper segments are kept, so /deeplink/runs/run_123 reaches the run
  const page = ENV_PAGE_SEGMENTS.has(segments[0] ?? "") ? segments.join("/") : undefined;

  const presenter = new SelectBestEnvironmentPresenter();
  try {
    const { project, organization, environment } = await presenter.call({ user });
    const environmentPath = v3EnvironmentPath(organization, project, environment);

    if (!page) {
      return redirect(environmentPath);
    }

    const { search } = new URL(request.url);
    return redirect(`${environmentPath}/${page}${search}`);
  } catch (_e) {
    //the presenter throws when the user has no projects, same as the dashboard index
    const organization = await prisma.organization.findFirst({
      where: {
        members: {
          some: {
            userId: user.id,
          },
        },
        deletedAt: null,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (organization) {
      return redirect(newProjectPath(organization));
    }

    return redirect(newOrganizationPath());
  }
};
