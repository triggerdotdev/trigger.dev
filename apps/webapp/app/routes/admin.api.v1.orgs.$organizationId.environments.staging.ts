import { withAdminApi } from "~/services/adminApi.server";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireBillingServiceRequest } from "~/services/billingServiceAuth.server";
import { enqueueOrgProvisioningJob } from "~/v3/services/orgProvisioningJobs.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
});

async function handleAction({ request, params }: ActionFunctionArgs) {
  await requireBillingServiceRequest(request);

  const { organizationId } = ParamsSchema.parse(params);

  const organization = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { id: true },
  });
  if (!organization) {
    return json({ error: "Organization not found" }, { status: 404 });
  }

  await enqueueOrgProvisioningJob("org.provisionStagingEnvironments", organizationId);

  return json({ success: true, queued: true }, { status: 202 });
}

export const action = withAdminApi(handleAction);
