import { redirect } from "remix-typedjson";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { customerPortalUrl } from "~/services/platform.v3.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { OrganizationParamsSchema, v3BillingPath } from "~/utils/pathBuilder";

export const loader = dashboardLoader(
  {
    params: OrganizationParamsSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    authorization: { action: "manage", resource: { type: "billing" } },
    // Redirect endpoint (no UI): keep redirecting on denial rather than
    // throwing the permission panel.
    unauthorizedRedirect: "/",
  },
  async ({ request, params, user }) => {
    const { organizationSlug } = params;

    const org = await prisma.organization.findFirst({
      select: {
        id: true,
      },
      where: {
        slug: organizationSlug,
        members: {
          some: {
            userId: user.id,
          },
        },
      },
    });

    if (!org) {
      return redirectWithErrorMessage(
        v3BillingPath({ slug: organizationSlug }),
        request,
        "Something went wrong. Please try again later."
      );
    }

    const result = await customerPortalUrl(org.id, organizationSlug);
    if (!result || !result.success || !result.customerPortalUrl) {
      return redirectWithErrorMessage(
        v3BillingPath({ slug: organizationSlug }),
        request,
        "Something went wrong. Please try again later."
      );
    }

    return redirect(result.customerPortalUrl);
  }
);
