import { parse } from "@conform-to/zod";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { SetPlanBodySchema } from "@trigger.dev/platform/v2";
import { redirect } from "remix-typedjson";
import { prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { BillingService } from "~/services/billing.v2.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import {
  OrganizationParamsSchema,
  organizationBillingPath,
  subscribedPath,
} from "~/utils/pathBuilder";

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);

  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: SetPlanBodySchema });
  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
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
      submission.error.message = "Invalid organization";
      return json(submission);
    }

    const billingPresenter = new BillingService(true);
    const result = await billingPresenter.setPlan(org.id, submission.value);
    if (result === undefined) {
      submission.error.message = "No billing client";
      return json(submission);
    }

    if (!result.success) {
      submission.error.message = result.error;
      return json(submission);
    }

    switch (result.action) {
      case "create_subscription_flow_start": {
        return redirect(result.checkoutUrl);
      }
      case "canceled_subscription": {
        return redirectWithSuccessMessage(
          organizationBillingPath({ slug: organizationSlug }),
          request,
          "Your subscription has been canceled."
        );
      }
      case "updated_subscription": {
        return redirect(subscribedPath({ slug: organizationSlug }), request);
      }
    }
  } catch (e) {
    logger.error("Error setting plan", { error: e });
    submission.error.message = e instanceof Error ? e.message : JSON.stringify(e);
    return json(submission);
  }
}
