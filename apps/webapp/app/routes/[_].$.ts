import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { getUsersInvites } from "~/models/member.server";
import { SelectBestEnvironmentPresenter } from "~/presenters/SelectBestEnvironmentPresenter.server";
import { requireUser } from "~/services/session.server";
import {
  deeplinkSuffix,
  resolveDeeplinkPage,
  resolveOrganizationDeeplinkPage,
} from "~/utils/deeplinkPages";
import {
  invitesPath,
  newOrganizationPath,
  newProjectPath,
  organizationSettingsPath,
  v3EnvironmentPath,
} from "~/utils/pathBuilder";

//`[_]` escapes the underscore: an unescaped `_.$` is a pathless layout, mounted at `/*`.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const url = new URL(request.url);
  const { pathname } = url;
  // `?project=<ref>` picks the project (the docs send the one the reader picked there).
  const projectRef = url.searchParams.get("project") ?? undefined;
  url.searchParams.delete("project");
  // `?env=dev` lands in the user's own dev environment (docs keys live there), not the last one used.
  const devEnvironment = url.searchParams.get("env") === "dev";
  url.searchParams.delete("env");
  const query = url.search;
  const suffix = deeplinkSuffix(pathname);
  const page = resolveDeeplinkPage(suffix);
  const organizationPage = resolveOrganizationDeeplinkPage(suffix);

  const invites = await getUsersInvites({ email: user.email });
  if (invites.length > 0) {
    return redirect(invitesPath());
  }

  const presenter = new SelectBestEnvironmentPresenter();
  try {
    const { project, organization, environment, projectRefMatched } = await presenter.call({
      user,
      projectRef,
      devEnvironment,
    });
    if (organizationPage) {
      return redirect(`${organizationSettingsPath(organization)}/${organizationPage}${query}`);
    }
    // A link meant for another project keeps its page but not its query (e.g. an example payload).
    const search = projectRefMatched ? query : "";

    const environmentPath = v3EnvironmentPath(organization, project, environment);
    const pageSuffix = page ? `/${page}` : "";

    return redirect(`${environmentPath}${pageSuffix}${search}`);
  } catch (_e) {
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
      if (organizationPage) {
        return redirect(`${organizationSettingsPath(organization)}/${organizationPage}${query}`);
      }

      return redirect(newProjectPath(organization));
    }

    return redirect(newOrganizationPath());
  }
};
