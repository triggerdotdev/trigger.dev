import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { $replica } from "~/db.server";
import { clearImpersonation, redirectWithImpersonation } from "~/models/admin.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  // If already impersonating, we need to clear the impersonation
  if (user.isImpersonating) {
    const url = new URL(request.url);
    return clearImpersonation(request, url.pathname);
  }

  // Only admins can impersonate
  if (!user.admin) {
    return redirect("/");
  }

  const path = params["*"];
  const organizationSlug = params.organizationSlug;

  logger.debug("Impersonating user", { path, organizationSlug });

  if (!organizationSlug) {
    logger.debug("Exiting impersonation mode");
    return clearImpersonation(request, "/admin");
  }

  const org = await $replica.organization.findFirst({
    where: {
      slug: organizationSlug,
      deletedAt: null,
    },
    select: {
      members: {
        select: {
          user: {
            select: {
              id: true,
              confirmedBasicDetails: true,
            },
          },
        },
      },
    },
  });

  if (!org) {
    logger.debug("Organization not found", { organizationSlug });
    return clearImpersonation(request, "/admin");
  }

  const firstValidMember = org.members.find((m) => m.user.confirmedBasicDetails);

  if (!firstValidMember) {
    logger.debug("No valid members found", { organizationSlug });
    return clearImpersonation(request, "/admin");
  }

  return redirectWithImpersonation(
    request,
    firstValidMember.user.id,
    `/orgs/${organizationSlug}/${path}`
  );
}
