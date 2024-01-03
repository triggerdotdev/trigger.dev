import { ActionFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { prisma } from "~/db.server";
import { redirectBackWithErrorMessage, redirectWithErrorMessage } from "~/models/message.server";
import { BillingService } from "~/services/billing.server";
import { requireUser } from "~/services/session.server";
import { OrganizationParamsSchema, usagePath } from "~/utils/pathBuilder";

export async function loader({ request, params }: ActionFunctionArgs) {
  const user = await requireUser(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const org = await prisma.organization.findUnique({
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
