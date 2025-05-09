import { type ActionFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { customerPortalUrl } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import { OrganizationParamsSchema, v3BillingPath } from "~/utils/pathBuilder";

export async function loader({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const org = await prisma.organization.findUnique({
    select: {
      id: true,
    },
    where: {
      slug: organizationSlug,
      members: {
        some: {
          userId,
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
