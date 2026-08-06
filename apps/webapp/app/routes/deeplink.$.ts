import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { getUsersInvites } from "~/models/member.server";
import { SelectBestEnvironmentPresenter } from "~/presenters/SelectBestEnvironmentPresenter.server";
import { requireUser } from "~/services/session.server";
import { deeplinkSuffix, resolveDeeplinkPage } from "~/utils/deeplinkPages";
import {
  invitesPath,
  newOrganizationPath,
  newProjectPath,
  v3EnvironmentPath,
} from "~/utils/pathBuilder";

/**
 * Stable links that don't name an org, project or environment: /deeplink/apikeys redirects to
 * /orgs/{org}/projects/{project}/env/{env}/apikeys for whoever is signed in. Only the pages in
 * ENV_PAGE_TARGETS are followed, so an unrecognised path can never become the redirect target —
 * it lands on the resolved environment instead.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  //the suffix comes from the pathname, not the splat param, so an id containing an escaped slash
  //survives — see deeplinkSuffix
  const { pathname, search } = new URL(request.url);
  const page = resolveDeeplinkPage(deeplinkSuffix(pathname));

  //a deeplink is the kind of URL a new invitee is sent, so take them to the invite first, exactly
  //as the dashboard index does
  const invites = await getUsersInvites({ email: user.email });
  if (invites.length > 0) {
    return redirect(invitesPath());
  }

  const presenter = new SelectBestEnvironmentPresenter();
  try {
    const { project, organization, environment } = await presenter.call({ user });
    const environmentPath = v3EnvironmentPath(organization, project, environment);

    //Both an unrecognised name and `tasks` (which targets the environment root) leave no suffix,
    //and the query survives either way, so all three spellings of "the environment" agree.
    const suffix = page ? `/${page}` : "";

    return redirect(`${environmentPath}${suffix}${search}`);
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
