import { LoaderArgs, redirect } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import {
  redirectBackWithErrorMessage,
  redirectWithErrorMessage,
} from "~/models/message.server";
import { getCurrentOrg } from "~/services/currentOrganization.server";
import {
  commitCurrentTemplateSession,
  setCurrentTemplate,
} from "~/services/currentTemplate.server";
import { getUserId } from "~/services/session.server";

export async function loader({ request }: LoaderArgs) {
  const url = new URL(request.url);
  const templateId = url.searchParams.get("templateId");

  if (!templateId) {
    return redirectWithErrorMessage(
      "/templates",
      request,
      "No template ID provided"
    );
  }

  const userId = await getUserId(request);

  if (userId) {
    const currentOrg = await getCurrentOrg(request);

    if (!currentOrg) {
      const firstOrg = await prisma.organization.findFirst({
        where: {
          users: {
            some: {
              id: userId,
            },
          },
        },
      });

      if (!firstOrg) {
        return redirectWithErrorMessage(
          "/templates",
          request,
          "Could not find an organization for this user"
        );
      }

      return redirect(
        `/orgs/${firstOrg.slug}/templates/add?templateId=${templateId}`
      );
    }

    return redirect(
      `/orgs/${currentOrg}/templates/add?templateId=${templateId}`
    );
  }

  const session = await setCurrentTemplate(templateId, request);

  const searchParams = new URLSearchParams([
    ["redirectTo", `${url.pathname}${url.search}`],
  ]);

  return redirect(`/login?${searchParams}`, {
    headers: {
      "Set-Cookie": await commitCurrentTemplateSession(session),
    },
  });
}
