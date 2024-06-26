import { ActionFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { BillingService } from "~/services/billing.v3.server";
import { requireUserId } from "~/services/session.server";
import { OrganizationParamsSchema, usagePath } from "~/utils/pathBuilder";

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
      usagePath({ slug: organizationSlug }),
      request,
      "Something went wrong. Please try again later."
    );
  }

  const billingPresenter = new BillingService(true);
  const result = await billingPresenter.customerPortalUrl(org.id, organizationSlug);

  if (!result || !result.success || !result.customerPortalUrl) {
    return redirectWithErrorMessage(
      usagePath({ slug: organizationSlug }),
      request,
      "Something went wrong. Please try again later."
    );
  }

  return redirect(result.customerPortalUrl);
}
