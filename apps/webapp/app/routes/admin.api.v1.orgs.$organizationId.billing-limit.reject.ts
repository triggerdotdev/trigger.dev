import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { bustBillingLimitCaches } from "~/services/platform.v3.server";
import { BillingLimitConvergeEnvironmentsService } from "~/v3/services/billingLimit/billingLimitConvergeEnvironmentsService.server";
import { enqueueBillingLimitConverge } from "~/v3/billingLimitWorker.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

/** Billing platform webhook: org billing limit grace expired. Idempotent — returns 202. */
export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  if (request.method.toLowerCase() !== "post") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const { organizationId } = ParamsSchema.parse(params);

  const organization = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { id: true },
  });

  if (!organization) {
    return json({ error: "Organization not found" }, { status: 404 });
  }

  bustBillingLimitCaches(organizationId);
  await BillingLimitConvergeEnvironmentsService.seedReconcileQueue(organizationId);
  await enqueueBillingLimitConverge(organizationId, "rejected");

  return json({ success: true, accepted: true }, { status: 202 });
}
