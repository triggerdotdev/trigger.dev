import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { SelectBestEnvironmentPresenter } from "~/presenters/SelectBestEnvironmentPresenter.server";
import { requireUser } from "~/services/session.server";
import { resolveDeeplinkPage } from "~/utils/deeplinkPages";
import { newOrganizationPath, newProjectPath, v3EnvironmentPath } from "~/utils/pathBuilder";

/**
 * Stable links that don't name an org, project or environment: /deeplink/apikeys redirects to
 * /orgs/{org}/projects/{project}/env/{env}/apikeys for whoever is signed in. Only the pages in
 * ENV_PAGE_TARGETS are followed, so an unrecognised path can never become the redirect target —
 * it lands on the resolved environment instead.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const page = resolveDeeplinkPage(params["*"] ?? "");
  const { search } = new URL(request.url);

  const presenter = new SelectBestEnvironmentPresenter();
  try {
    const { project, organization, environment } = await presenter.call({ user });
    const environmentPath = v3EnvironmentPath(organization, project, environment);

    //an unrecognised path keeps nothing: it lands on the environment as if no suffix was given
    if (page === undefined) {
      return redirect(environmentPath);
    }

    //`tasks` targets the environment root, so there is no suffix to append
    return redirect(page ? `${environmentPath}/${page}${search}` : `${environmentPath}${search}`);
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
