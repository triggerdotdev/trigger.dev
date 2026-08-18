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
  organizationRuntimeUpdatesPath,
  v3EnvironmentPath,
} from "~/utils/pathBuilder";

//`[_]` escapes the underscore: an unescaped `_.$` is a pathless layout, mounted at `/*`.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  const { pathname, search } = new URL(request.url);
  const suffix = deeplinkSuffix(pathname);
  const page = resolveDeeplinkPage(suffix);
  const organizationPage = resolveOrganizationDeeplinkPage(suffix);

  const invites = await getUsersInvites({ email: user.email });
  if (invites.length > 0) {
    return redirect(invitesPath());
  }

  const presenter = new SelectBestEnvironmentPresenter();
  try {
    const { project, organization, environment } = await presenter.call({ user });
    if (organizationPage === "runtime-updates") {
      return redirect(`${organizationRuntimeUpdatesPath(organization)}${search}`);
    }

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
      if (organizationPage === "runtime-updates") {
        return redirect(`${organizationRuntimeUpdatesPath(organization)}${search}`);
      }

      return redirect(newProjectPath(organization));
    }

    return redirect(newOrganizationPath());
  }
};
